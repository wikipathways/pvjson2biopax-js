var _ = require('lodash');
var btoa = require('btoa');
var Gpml2PvjsonConverter = require('gpml2pvjson');
var jsonld = require('jsonld');
// NOTE: using this fork, because we need to use xmldom, not jsdom:
var $rdf = require('rdflib');
var Rx = require('rx');
var RxNode = require('rx-node');
var utils = require('../node_modules/gpml2pvjson/lib/utils.js');
var uuid = require('uuid');
var VError = require('verror');

var filename = 'pvjson2biopax-js/lib/main.js';

var dereferenceElement = utils.dereferenceElement;

var biopaxEdgeTypes = utils.biopax.edgeTypes;
var biopaxNodeTypes = utils.biopax.nodeTypes;
var biopaxTypes = utils.biopax.allTypes;

var tmGpmlDataNodePrefixed2BiopaxEntityPlain =
    utils.typeMappings.gpmlDataNodePrefixed2biopaxEntityPlain;

function createXrefIdFromDbAndIdentifier(db, identifier, type) {
  return encodeURIComponent(type + '_' + btoa(db + identifier));
}

// this works, but it requires munging "SBO:" to "SBO". output is rdf/xml
function pvjson2biopax(pathwayMetadata, pvjson) {
  // TODO handle pvjson regardless of whether
  // it is provided as a string, JSON or a JS object

  // For quick access to those namespaces:
  var FOAF = $rdf.Namespace('http://xmlns.com/foaf/0.1/');
  var RDF = $rdf.Namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
  var RDFS = $rdf.Namespace('http://www.w3.org/2000/01/rdf-schema#');
  var OWL = $rdf.Namespace('http://www.w3.org/2002/07/owl#');
  var DC = $rdf.Namespace('http://purl.org/dc/elements/1.1/');
  var RSS = $rdf.Namespace('http://purl.org/rss/1.0/');
  var XSD = $rdf.Namespace('http://www.w3.org/TR/2004/REC-xmlschema-2-20041028/#dt-');

  var referenceTypes = [
    'ProteinReference',
    'SmallMoleculeReference',
    'DnaReference',
    'RnaReference',
    'GeneReference'
  ];

  function duplicateElement(elements, id) {
    var originalElement = dereferenceElement(elements, id);
    var newElement = _.clone(originalElement);
    var newId = uuid.v4();
    newElement.id = newId;
    elements.push(newElement);
    return newElement;
  }

  function convertFromN3ToRdfXml(input, callback) {
    // - create an empty store
    var kb = new $rdf.IndexedFormula();

    // NOTE: to get rdflib.js' RDF/XML parser to work with node.js,
    // see https://github.com/linkeddata/rdflib.js/issues/47

    // - parse N3 file
    $rdf.parse(input, kb, 'http://schema.rdfs.org/all.nt', 'text/n3', function(err, kb) {
      if (err) {
        var err2 = new VError(err, 'failed to parse N3 in "%s"', filename);
        return callback(err2);
      }

      $rdf.serialize(undefined, kb, undefined, 'application/rdf+xml', function(err, str) {
        if (err) {
          var err2 = new VError(err, 'failed to serialize N3 in "%s"', filename);
          return callback(err2);
        }
        return callback(null, str);
      });
    });
  }

  return Rx.Observable.return(pathwayMetadata)
    .map(function(pathwayMetadata) {
      var identifier = pathwayMetadata.identifier;
      var version = pathwayMetadata.version || 0;

      var pathwayIri = !!identifier ?
          'http://identifiers.org/wikipathways/' +
          identifier : gpmlLocation;
      pvjson.id = pathwayIri;
      pvjson.version = version;

      pvjson['@context'].filter(function(contextElement) {
        return contextElement.hasOwnProperty('@base');
      })
      .map(function(baseElement) {
        baseElement['@base'] = pathwayIri + '/';
      });

      return pvjson;
    })
    .map(function(pvjson) {
      pvjson.elements = pvjson.elements
        .filter(function(element) {
          return !!element.type;
        })
        .map(function(element) {
          var type = element.type;
          element.type = _.isArray(type) ? type : [type];
          return element;
        })
        .concat(pvjson.elements.filter(function(element) {
          return !element.type;
        }));
      return pvjson;
    })
    .flatMap(function(pvjson) {
      var elementList = pvjson.elements;
      var partitionSource = Rx.Observable.from(elementList)
        .partition(function(element) {
          return !!element.getSetEntityReference;
        });

      var entitiesWithEntityReferenceSource = partitionSource[0]
        .concatMap(function(element) {
          return Rx.Observable.fromPromise(element.getSetEntityReference())
            .flatMap(function(enrichedBridgeDbStyleEntityReference) {
              var enrichedEntityReference = {};
              enrichedEntityReference.id = enrichedBridgeDbStyleEntityReference.id;
              //enrichedEntityReference.type = enrichedBridgeDbStyleEntityReference.type;
              var subject = enrichedBridgeDbStyleEntityReference.isDataItemIn.subject;
              var biopaxSubjectsFromBridgeDb = _.filter(subject, function(item) {
                return item.indexOf('biopax') > -1;
              });
              var biopaxEntityReferenceTypesFromBridgeDb =
                  _.filter(enrichedBridgeDbStyleEntityReference.type,
                    function(item) {
                      return item.indexOf('biopax') > -1;
                    });
              var intersection = _.intersection(
                  biopaxSubjectsFromBridgeDb, biopaxEntityReferenceTypesFromBridgeDb);
              if (intersection.length > 0) {
                var entityReferenceType = intersection[0];
                enrichedEntityReference.type = entityReferenceType;
                var entityTypeFromEntityReference = entityReferenceType.replace(/Reference$/, '');

                var entityType = element.type;
                var entityTypeAsArray = _.isArray(entityType) ? entityType : [entityType];

                if (entityTypeAsArray.indexOf(entityTypeFromEntityReference) === -1) {
                  // TODO is there a better way to handle this case where
                  // a pathway author annotates a Protein with a Dna reference,
                  // such as from Ensembl or Entrez Gene?
                  // What if we changed the entity reference using a BridgeDb query
                  // for example, from a DnaReference to a corresponding
                  // ProteinReference (swiss-prot), ?
                  console.warn('Changing entity type from:');
                  console.warn(entityType);
                  console.warn('to "' + entityTypeFromEntityReference + '"');
                  console.warn('in order to make the BioPAX validator happy.');
                }

                element.type = entityTypeFromEntityReference;
              }

              enrichedEntityReference.displayName = element.displayName;

  /* TODO check whether any of this old code from gpml2pvjson's xref.js is still useful here
  var xrefDataProperty;
  if (currentClassLevelGpmlElement.name === 'DataNode' ||
      currentClassLevelGpmlElement.name === 'Group') {
    xrefDataProperty = 'entityReference';
  } else if (pvjsonXref.type === 'Evidence') {
    xrefDataProperty = xrefDataProperty.toLowerCase();
  } else {
    xrefDataProperty = 'xref';
  }

//  // If there is no currentClassLevelPvjsonElement[xrefDataProperty], just set it equal
//  // to pvjsonXrefId.
//  // If there is already a value for currentClassLevelPvjsonElement[xrefDataProperty],
//  // but the value is not an array, convert currentClassLevelPvjsonElement[xrefDataProperty]
//  // to an array, then push both the existing value and the new value;
//  // otherwise, just push pvjsonXrefId into the existing array.
//  if (!currentClassLevelPvjsonElement[xrefDataProperty]) {
//    currentClassLevelPvjsonElement[xrefDataProperty] = pvjsonXrefId;
//  } else if (_.isArray(currentClassLevelPvjsonElement[xrefDataProperty])) {
//    currentClassLevelPvjsonElement[xrefDataProperty].push(pvjsonXrefId);
//  } else {
//    currentClassLevelPvjsonElement[xrefDataProperty] =
//      [currentClassLevelPvjsonElement[xrefDataProperty]];
//    currentClassLevelPvjsonElement[xrefDataProperty].push(pvjsonXrefId);
//  }
//
//  // check whether this pvjsonXref has already been added
//  var pvjsonXrefArray = pvjson.elements.filter(function(element) {
//    return pvjsonXrefId === element.id;
//  });
//  if (pvjsonXrefArray.length === 0) {
//    pvjson.elements.push(pvjsonXref);
//    result.pvjson = pvjson;
//  } else {
//    var otherXref = pvjsonXrefArray[0];
//    // handles cases such as a Protein DataNode being annotated with an ID for
//    // DNA, which is not correct in BioPAX.
//    if (otherXref.type !== pvjsonXref.type) {
////      var pvjsonRelationshipXref = {};
////      var pvjsonRelationshipXrefId = 'http://example.org/' + uuid.v4();
////      // Current tooling messes up when I use rdf:ID
////      //pvjsonRelationshipXref['http://www.w3.org/1999/02/22-rdf-syntax-ns#ID'] =
////      //  pvjsonRelationshipXrefId;
////      pvjsonRelationshipXref.id = pvjsonRelationshipXrefId;
////      pvjsonRelationshipXref.type = 'RelationshipXref';
////      var preferredPrefix = decodeURIComponent(
////          pvjsonXrefId.match(/(identifiers.org\/)(.*)(?=\/.*)/)[2]);
////      pvjsonRelationshipXref['biopax:db'] = preferredPrefix;
////      pvjsonRelationshipXref['biopax:id'] = identifier;
////      pvjson.elements.push(pvjsonRelationshipXref);
//
//      pvjsonXrefId = 'http://example.org/' + uuid.v4();
//      pvjsonXref.id = pvjsonXrefId;
//      pvjsonXref.xref = pvjsonRelationshipXrefId;
//      pvjson.elements.push(pvjsonXref);
//
//      currentClassLevelPvjsonElement.entityReference = pvjsonXrefId;
//
//      result.pvjson = pvjson;
//    }
//  }
  //*/

              var enrichedUnificationXref = {};
              enrichedUnificationXref.type = 'UnificationXref';
              enrichedUnificationXref.db = enrichedBridgeDbStyleEntityReference.db || 'Unknown';
              enrichedUnificationXref.identifier =
                  enrichedBridgeDbStyleEntityReference.identifier || 'Unknown';

              var enrichedUnificationXrefId = createXrefIdFromDbAndIdentifier(
                enrichedUnificationXref.db,
                enrichedUnificationXref.identifier,
                'UnificationXref');

              enrichedUnificationXref.id = enrichedUnificationXrefId;
              enrichedEntityReference.xref = enrichedUnificationXrefId;
              /* TODO: how can we include the BridgeDb and MyGene.info linkouts?
              var xrefs = enrichedBridgeDbStyleEntityReference.xref || [];
              xrefs = _.isArray(xrefs) ? xrefs : [xrefs];
              xrefs.push(enrichedUnificationXrefId);
              enrichedEntityReference.xref = xrefs;
              //*/

              delete element.getSetEntityReference;
              delete element.bridgeDbDataSourceName;
              delete element.db;
              delete element.identifier;

              return Rx.Observable.from([
                element,
                enrichedEntityReference,
                enrichedUnificationXref
              ]);
            });
        })
        .distinct(function(element) {
          return element.id;
        });

      var entitiesLackingEntityReferenceSource = partitionSource[1];

      return Rx.Observable.merge(
        entitiesWithEntityReferenceSource,
        entitiesLackingEntityReferenceSource
      )
        .toArray()
        .map(function(elementList) {
          pvjson.elements = elementList;
          return pvjson;
        });
    })
    .map(function(pvjson) {
      // NOTE: Doing two things:
      // 1) Getting BioPAX type if multiple types specified
      // 2) Removing biopax: prefix from all types, whether
      //    type is specified as an array or a string
      pvjson.elements = pvjson.elements
        .filter(function(element) {
          return _.isArray(element.type);
        })
        .map(function(element) {
          element.type = element.type.map(function(oneType) {
            return oneType.replace('biopax:', '');
          });
          return element;
        })
        .map(function(element) {
          var type = element.type;
          var intersection = _.intersection(type, biopaxTypes);
          element.type = intersection.length > 0 ? intersection[0] : element.type[0];
          return element;
        })
        .concat(
            pvjson.elements.filter(function(element) {
              return !element.type;
            })
        )
        .concat(
            pvjson.elements.filter(function(element) {
              return !!element.type && !_.isArray(element.type);
            })
            .map(function(element) {
              element.type = element.type.replace('biopax:', '');
              return element;
            })
        );
      return pvjson;
    })
    .map(function(pvjson) {
      pvjson.elements = pvjson.elements
        .filter(function(element) {
          return element.type === 'Pathway';
        })
        .map(function(element) {
          delete element.entityReference;
          return element;
        })
        .concat(pvjson.elements.filter(function(element) {
          return element.type !== 'Pathway';
        }));
      return pvjson;
    })
    .map(function(pvjson) {
      // gpml:Labels and gpml:Shapes are not really BioPAX
      // elements, but if they are attached to a BioPAX edge,
      // we'll include them as PhysicalEntities.

      var referencedIds = {};
      var elements = pvjson.elements;
      elements
        .filter(function(element) {
          return !_.isEmpty(element.controlled) && !_.isEmpty(element.controller);
        })
        .forEach(function(group) {
          referencedIds[group.controller] = true;
          referencedIds[group.controlled] = true;
        });

      elements
        .filter(function(element) {
          return element.participant;
        })
        .forEach(function(interaction) {
          interaction.participant.forEach(function(elementId) {
            referencedIds[elementId] = true;
          });
        });

      elements
        .filter(function(element) {
          return element.contains;
        })
        .forEach(function(group) {
          group.contains.forEach(function(elementId) {
            referencedIds[elementId] = true;
          });
        });

      pvjson.elements = pvjson.elements
        .filter(function(element) {
          return ['gpml:Label', 'gpml:Shape'].indexOf(element.type) > -1;
        })
        .filter(function(element) {
          return referencedIds[element.id];
        })
        .map(function(element) {
          element.type = 'PhysicalEntity';
          return element;
        })
        .concat(
          pvjson.elements
            .filter(function(element) {
              return ['gpml:Label', 'gpml:Shape'].indexOf(element.type) === -1;
            })
        );
      return pvjson;
    })
    .map(function(pvjson) {
      pvjson.elements = pvjson.elements
        .map(function(element) {
          delete element.backgroundColor;
          delete element.borderWidth;
          delete element.color;
          delete element.contains;
          delete element.displayId;
          delete element.fillOpacity;
          delete element.fontSize;
          delete element.fontStyle;
          delete element.fontWeight;
          delete element['gpml:element'];
          delete element['gpml:Type'];
          delete element.height;
          delete element.isAttachedTo;
          delete element.isPartOf;
          delete element.padding;
          delete element.rotation;
          delete element.shape;
          delete element.strokeDasharray;
          delete element.textAlign;
          delete element.verticalAlign;
          delete element.width;
          delete element.x;
          delete element.y;
          delete element.relX;
          delete element.relY;
          delete element.zIndex;
          delete element.points;
          delete element.markerStart;
          delete element.markerEnd;
          return element;
        });
      return pvjson;
    })
    //*
    .map(function(pvjson) {
      pvjson.elements = pvjson.elements.filter(function(element) {
          return !element.contains;
        })
        .concat(
          pvjson.elements
            .filter(function(element) {
              return !!element.contains;
            })
            .map(function(group) {
              group.contains = group.contains
                .map(function(elementId) {
                  return dereferenceElement(pvjson.elements, elementId);
                })
                .filter(function(element) {
                  return element && element.id &&
                    element.type && biopaxTypes.indexOf(element.type) > -1;
                })
                .map(function(element) {
                  // NOTE: we just want to return the element's ID, not the whole element here.
                  /*
                  return {
                    id: pathwayIri + '/' + element.id
                  };
                  //*/
                  //return pathwayIri + '/' + element.id;
                  return element.id;
                });
              return group;
            })
        );
      return pvjson;
    })
    //*/

    // A Catalysis has properties controlled and controller
    //   controlled must reference a Conversion
    //   controller must reference a Pathway or PhysicalEntity
    //
    // A Conversion has properties left, right and conversionDirection
    //   conversionDirection is a string with one of these values:
    //     LEFT-TO-RIGHT, REVERSIBLE, RIGHT-TO-LEFT
    //   left must reference a PhysicalEntity
    //   right must reference a PhysicalEntity
    /*
    .map(function(pvjson) {
      pvjson.elements = pvjson.elements
        .filter(function(element) {
          return element.type === 'Control';
        })
        .map(function(element) {
          var genericInteraction = {};
          genericInteraction.participant = [
            element.controller,
            element.controlled
          ];
          genericInteraction.id = element.id;
          genericInteraction.type = 'Interaction';
          return genericInteraction;
        })
        .concat(pvjson.elements.filter(function(element) {
          return element.type !== 'Control';
        }));
      return pvjson;
    })
    //*/
    .map(function(pvjson) {
      // For now, don't include xrefs for anything except DnaReferences,
      // RnaReferences, ProteinReferences and SmallMoleculeReferences.
      // TODO get other xrefs working, such as for PublicationXrefs.
      pvjson.elements = pvjson.elements
        .filter(function(element) {
          return element.type.indexOf('Reference') === -1;
        })
        .map(function(element) {
          delete element.xref;
          return element;
        })
        .concat(
          pvjson.elements
            .filter(function(element) {
              return element.type.indexOf('Reference') > -1;
            })
        );
      return pvjson;
    })
    .map(function(pvjson) {
      pvjson.elements = pvjson.elements
        .filter(function(element) {
          return biopaxEdgeTypes.indexOf(element.type) > -1;
        })
        .map(function(element) {
          delete element.interactionType;
          return element;
        })
        .concat(
          pvjson.elements
            .filter(function(element) {
              return biopaxEdgeTypes.indexOf(element.type) === -1;
            })
        );
      return pvjson;
    })
    .map(function(pvjson) {
      pvjson.elements
        .filter(function(element) {
          return element.type === 'GeneticInteraction';
        })
        .map(function(element) {
          element.participant
            .map(function(participantId) {
              return dereferenceElement(pvjson.elements, participantId);
            })
            .filter(function(participant) {
              // BioPAX GeneticInteractions are only between Genes
              return participant.type !== 'Gene';
            })
            .forEach(function(participant) {
              participant.type = 'Gene';
              delete participant.entityReference;
            });

          return element;
        })
        .map(function(element) {
          var participants = element.participant;
          if (participants.length === 2) {
            var firstId = participants[0];
            var secondId = participants[1];
            if (firstId === secondId) {
              var newParticipant = duplicateElement(pvjson.elements, firstId);
              var newParticipantId = newParticipant.id;
              participants[1] = newParticipantId;
            }
          }
          return element;
        });

      return pvjson;
    })
    .map(function(result) {
      function convertToBiopaxjson(pvjson) {
        var biopaxJson = {};
        var biopaxJsonContext = biopaxJson['@context'] = pvjson['@context'];
        var lastContextElement;
        if (_.isArray(biopaxJsonContext)) {
          lastContextElement = biopaxJsonContext[biopaxJsonContext.length - 1];
        } else {
          lastContextElement = biopaxJsonContext;
        }

        biopaxJson['@context'].unshift(
            'https://wikipathwayscontexts.firebaseio.com/owlPrerequisites.json');

        lastContextElement.biopax =
            'http://www.biopax.org/release/biopax-level3.owl#';

        var base = lastContextElement['@base'];

        biopaxJson['@graph'] = [];

        var owlElement = {
          '@id': base,
          '@type': 'http://www.w3.org/2002/07/owl#Ontology',
          'http://www.w3.org/2002/07/owl#imports': {
            '@id': lastContextElement.biopax
          }
        };

        biopaxJson['@graph'].unshift(owlElement);

        var pathway = {};
        pathway.id = pvjson.id;
        pathway.type = 'Pathway';
        /* TODO can we not add PublicationXrefs for a Pathway?
        if (pvjson.xref) {
          // TODO kludge. refactor.
          pathway.xref = pvjson.xref[0];
          delete pvjson.xref;
        }
        //*/
        if (pvjson.standardName) {
          //pathway.name = pvjson.standardName;
          pathway['biopax:name'] = pvjson.standardName;
        }
        if (pvjson.displayName) {
          delete pathway.displayName;
        }

        pvjson.elements.filter(function(entity) {
          return !!entity.type;
        })
        .filter(function(entity) {
          return _.keys(tmGpmlDataNodePrefixed2BiopaxEntityPlain).indexOf(entity.type) > -1;
        })
        .forEach(function(entity) {
          entity.type = tmGpmlDataNodePrefixed2BiopaxEntityPlain[entity.type];
        });

        var pathwayComponent = [];
        pvjson.elements.forEach(function(entity) {
          if (entity.type) {
            var type = entity.type;
            if (biopaxTypes.indexOf(type) > -1) {
              if (entity.contains) {
                var containedElementIds = entity.contains;
                delete entity.contains;
                if (!_.isArray(containedElementIds)) {
                  containedElementIds = [containedElementIds];
                }
                if (entity.type === 'Pathway') {
                  entity.pathwayComponent = containedElementIds
                    .map(function(containedElementId) {
                      return dereferenceElement(pvjson.elements, containedElementId);
                    })
                    .filter(function(containedElement) {
                      return biopaxEdgeTypes.indexOf(containedElement.type) > -1;
                    })
                    .map(function(containedElement) {
                      return containedElement.id;
                    });
                } else if (entity.type === 'Complex') {
                  entity.component = containedElementIds;
                }
              }
              biopaxJson['@graph'].push(entity);
            }

            if (biopaxEdgeTypes.indexOf(type) > -1) {
              pathwayComponent.push(entity.id);
            }
          }
        });
        pathway.pathwayComponent = pathwayComponent;
        biopaxJson['@graph'].push(pathway);

        biopaxJson['@graph'].filter(function(entity) {
          return !!entity.type;
        })
        .filter(function(entity) {
          return entity.type === 'PublicationXref';
        })
        .forEach(function(entity) {
          // TODO update the generation of these in the gpml2pvjson converter
          // so that we get this data.
          entity.db = 'Unknown';
          entity.identifier = 'Unknown';
          delete entity.displayName;
        });

        var references = biopaxJson['@graph']
          .filter(function(entity) {
            return !!entity.type;
          })
          .filter(function(entity) {
            return referenceTypes.indexOf(entity.type) > -1;
          });

        // TODO this is kludgy. Can we set up the JSON-LD contexts
        // such that we don't need this to specify the IRI for
        // the @id in the BioSource?
        var organismNameToIriMappings = {
          'Anopheles gambiae': 'http://identifiers.org/taxonomy/7165',
          'Arabidopsis thaliana': 'http://identifiers.org/taxonomy/3702',
          'Bacillus subtilis': 'http://identifiers.org/taxonomy/1423',
          'Bos taurus': 'http://identifiers.org/taxonomy/9913',
          'Caenorhabditis elegans': 'http://identifiers.org/taxonomy/6239',
          'Canis familiaris': 'http://identifiers.org/taxonomy/9615',
          'Danio rerio': 'http://identifiers.org/taxonomy/7955',
          'Drosophila melanogaster': 'http://identifiers.org/taxonomy/7227',
          'Escherichia coli': 'http://identifiers.org/taxonomy/562',
          'Equus caballus': 'http://identifiers.org/taxonomy/9796',
          'Gallus gallus': 'http://identifiers.org/taxonomy/9031',
          'Gibberella zeae': 'http://identifiers.org/taxonomy/5518',
          'Homo sapiens': 'http://identifiers.org/taxonomy/9606',
          'Hordeum vulgare': 'http://identifiers.org/taxonomy/4513',
          'Mus musculus': 'http://identifiers.org/taxonomy/10090',
          'Mycobacterium tuberculosis': 'http://identifiers.org/taxonomy/1773',
          'Oryza sativa': 'http://identifiers.org/taxonomy/4530',
          'Pan troglodytes': 'http://identifiers.org/taxonomy/9598',
          'Rattus norvegicus': 'http://identifiers.org/taxonomy/10116',
          'Saccharomyces cerevisiae': 'http://identifiers.org/taxonomy/4932',
          'Solanum lycopersicum': 'http://identifiers.org/taxonomy/4081',
          'Sus scrofa': 'http://identifiers.org/taxonomy/9823',
          'Zea mays': 'http://identifiers.org/taxonomy/4577'
        };

        var organismIri = organismNameToIriMappings[pvjson.organism];
        var organismDb = 'Taxonomy';
        var organismIdentifier = organismIri.split('http://identifiers.org/taxonomy/')[1];

        var bioSourceUnificationXrefId = createXrefIdFromDbAndIdentifier(
          organismDb,
          organismIdentifier,
          'UnificationXref');

        var bioSourceUnificationXref = {
          '@id': bioSourceUnificationXrefId,
          '@type': 'biopax:UnificationXref',
          'identifier': organismIdentifier,
          'db': organismDb
        };
        biopaxJson['@graph'].push(bioSourceUnificationXref);

        var bioSource = {
          '@id': organismIri,
          '@type': 'biopax:BioSource',
          'xref': bioSourceUnificationXrefId,
          'biopax:standardName': {
            '@value': pvjson.organism,
            '@type': 'xsd:string'
          }
        };
        biopaxJson['@graph'].push(bioSource);

        pathway.organism = organismIri;

        biopaxJson['@graph'].filter(function(element) {
          return [
            'Pathway',
            'DnaReference',
            'RnaReference',
            'ProteinReference'].indexOf(element.type) > -1;
        })
        .forEach(function(element) {
          element.organism = organismIri;
        });

        return biopaxJson;
      }

      return convertToBiopaxjson(result);
    })
    .flatMap(function(biopaxJson) {
      return Rx.Observable.fromNodeCallback(function(callback) {
        jsonld.expand(biopaxJson,
          function(err, expandedBiopaxJson) {
            if (err) {
              var err2 = new VError(err, 'failed to expand JSON-LD in "%s"', filename);
              throw err2;
            }
            return callback(null, expandedBiopaxJson);
          });
      })();
    })
    .flatMap(function(expandedBiopaxJson) {
      return Rx.Observable.fromNodeCallback(function(callback) {
        jsonld.toRDF(expandedBiopaxJson, {format: 'application/nquads'},
          function(err, biopaxNquads) {
            if (err) {
              var err2 = new VError(err, 'failed to convert JSON-LD to N-Quads in "%s"', filename);
              throw err2;
            }
            return callback(null, biopaxNquads);
          });
      })();
    })
    .flatMap(function(biopaxN3) {
      var cleaned = biopaxN3.replace(/SBO:/g, '')
        .replace(/http:\/\/rdaregistry.info\/Elements\/u\/P60052/g,
                 'http://www.biopax.org/release/biopax-level3.owl#id');
      return Rx.Observable.fromNodeCallback(function(callback) {
        convertFromN3ToRdfXml(cleaned, function(err, biopaxRdfXml) {
          if (err) {
            var err2 = new VError(err, 'failed to convert N-Quads to RDF/XML in "%s"', filename);
            throw err2;
          }
          return callback(null, biopaxRdfXml);
        });
      })();
    })
    .map(function(biopaxRdfXml) {
      var xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';
      return xmlHeader + '\n' + biopaxRdfXml;
    });
}

module.exports = {
  pvjson2biopax: pvjson2biopax
};
