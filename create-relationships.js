require("dotenv").config();
const axios = require("axios");
const { getJiraEpicLinkFieldId } = require("./jira-client");
const { JIRA_ID_CUSTOM_FIELD } = require("./openproject-client");

// OpenProject API configuration
const openProjectConfig = {
  baseURL: `${process.env.OPENPROJECT_HOST}/api/v3`,
  headers: {
    Authorization: `Basic ${Buffer.from(
      `apikey:${process.env.OPENPROJECT_API_KEY}`
    ).toString("base64")}`,
    "Content-Type": "application/json",
  },
};

const openProjectApi = axios.create(openProjectConfig);

// Store issue key to work package ID mapping
const issueToWorkPackageMap = new Map();

let resolvedEpicLinkField = null;

async function getEpicLinkFieldId() {
  if (!resolvedEpicLinkField) {
    resolvedEpicLinkField = await getJiraEpicLinkFieldId();
  }
  return resolvedEpicLinkField;
}

// Track missing relationships to retry later
const missingRelationships = new Set();

// Stats counters
let stats = { created: 0, skippedExisting: 0, skippedParent: 0, failed: 0, missing: 0, total: 0 };

/**
 * Defines the priority of relationship types.
 * Higher numbers indicate higher priority.
 *
 * #39: Because OpenProject accepts only a single relationship (whatever the type and direction)
 * between two work packages, whereas Jira allows multiple different links between the same issues,
 * we need to decide which one to keep. Chosen strategy is:
 * - Parent-child relationships take precedence over all others (but should be created separately, see migrate-parents.js)
 * - Then blocking relationships (blocks/blocked)
 * - Then duplicates (duplicates/duplicated)
 * - Then partof/includes (epic links)
 * - Finally, relates links are the lowest priority
 * Note:
 */
const relationshipPriority = {
  blocks: 300,
  blocked: 300,
  duplicates: 200,
  duplicated: 200,
  partof: 100,
  includes: 100,
  relates: 0,
};

/**
 * Check if a parent relationship already exists between two work packages
 * (whatever the direction is).
 * Unfortunately, OpenProject does not expose parent relationships via the /relations endpoint,
 * so we need to fetch the work package details to check for parent links.
 * https://www.openproject.org/docs/api/endpoints/work-packages/#view-work-package
 *
 * @param {string} fromId of Work Package to check relation for
 * @param {string} toId of Work Package to check relation for
 * @returns
 */
async function checkParentRelationship(fromId, toId) {
  try {
    // We do not care about direction here, just if a parent-child relationship exists,
    // so we pick one Work Package to fetch and check if the other one is its parent
    // or one of its children.
    const response = await openProjectApi.get(`/work_packages/${fromId}`);
    const parentLink = response.data._links.parent;
    const childrenLinks = response.data._links.children;
    const toIdStr = toId.toString();

    if (
      // Check if fromId has toId as parent...
      getHrefId(parentLink?.href) === toIdStr ||
      // ...or if fromId has toId as child
      childrenLinks?.find((child) => getHrefId(child?.href) === toIdStr)
    ) {
      console.log(
        `Found existing parent relationship between ${fromId} and ${toId}`
      );
      return true;
    }
  } catch (error) {
    console.error(`Error checking parent relationship: ${error.message}`);
  }
  return false;
}

/**
 * Extracts the ID from a given href by splitting on "/" and returning the last segment.
 * @example
 * getHrefId("/api/v3/work_packages/123") // returns "123"
 * @param {string | undefined} href - The href string to extract the ID from.
 * @returns {string | undefined} The extracted ID.
 */
function getHrefId(href) {
  return href?.split("/").pop();
}

async function checkExistingRelationship(fromId, toId, type) {
  try {
    // #33: OpenProject does not allow multiple relationships of any type
    // between the same two work packages, regardless of direction,
    // so detect them before attempting creation.
    // https://github.com/opf/openproject/blob/v16.6.3/app/models/work_packages/scopes/relatable.rb#L34-L201
    console.log(
      `\nChecking for existing relationship between ${fromId} and ${toId}`
    );
    // #33: parent-child prevents any other relationships, whatever their type and direction are.
    if (await checkParentRelationship(fromId, toId)) {
      console.log(
        `Found existing parent relationship, skipping ${type} creation`
      );
      return true;
    }

    // #33: strangely, "or" operator in filters does not seem to work as expected,
    // but we can simply list both work package IDs in both "to" and "from" filters
    // (this could also match relations from A to A or from B to B, but those are not possible in our case)
    const filter = {
      operator: "=",
      values: [fromId.toString(), toId.toString()],
    };
    const filters = [
      // #36: Check both ends of the relation as 2 separate filters
      // (OpenProject combines them with AND logic),
      // OpenProject expects objects with a single property
      // https://github.com/opf/openproject/blob/v16.6.3/app/services/api/v3/parse_query_params_service.rb#L138
      {
        from: filter,
      },
      {
        to: filter,
      },
    ];

    // Use the relations endpoint with filters
    const response = await openProjectApi.get("/relations", {
      params: {
        filters: JSON.stringify(filters),
      },
    });

    // If we find any relations matching our criteria, a relationship exists
    const exists = response.data.total > 0;
    console.log(
      `Relationship exists: ${exists} (found ${response.data.total} matches)`
    );

    // Add detailed logging about any found relationships
    if (exists && response.data._embedded.elements.length > 0) {
      const relation = response.data._embedded.elements[0];
      const existingType = relation.type;
      console.log("\nFound existing relationship details:");
      console.log(`- Relation ID: ${relation.id}`);
      console.log(`- Type: ${existingType}`);
      console.log(
        `- From: ${relation._links.from.title} (ID: ${relation._links.from.href
          .split("/")
          .pop()})`
      );
      console.log(
        `- To: ${relation._links.to.title} (ID: ${relation._links.to.href
          .split("/")
          .pop()})`
      );
      console.log(
        `- Direction: ${
          relation._links.from.href.split("/").pop() === fromId
            ? "forward"
            : "reverse"
        }`
      );

      // #39: Check if existing relationship has lower priority than the one we want to create
      const existingPriority = relationshipPriority[existingType] || 0;
      const newPriority = relationshipPriority[type] || 0;
      if (existingPriority < newPriority) {
        console.log(
          `Existing relationship type "${existingType}" has lower priority than "${type}", deleting it`
        );
        // Delete the existing relationship.
        // We could have attempted to update (patch) the existing relationship instead,
        // but we would have needed to carefully handle direction as well,
        // which would have complicated the logic further.
        await openProjectApi.delete(`/relations/${relation.id}`);
        console.log(
          `Deleted existing relationship ID ${relation.id} of type "${existingType}"`
        );
        return false; // Indicate that no relationship now exists
      } else {
        console.log(
          `Existing relationship type "${existingType}" has equal or higher priority than "${type}", keeping it`
        );
      }
    }

    return exists;
  } catch (error) {
    console.error(`Error checking existing relationship: ${error.message}`);
    if (error.response?.data) {
      console.error(
        "Error details:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    return false;
  }
}

async function createRelationship(fromId, toId, type) {
  try {
    console.log(
      `\nAttempting to create relationship: ${fromId} ${type} ${toId}`
    );

    // Check if relationship already exists
    const exists = await checkExistingRelationship(fromId, toId, type);
    if (exists) {
      console.log(
        `Relationship already exists: ${type} from ${fromId} to ${toId}`
      );
      stats.skippedExisting++;
      return;
    }

    // Create new relationship
    const payload = {
      type: type,
      description: "Created by Jira migration",
      lag: 0,
      _links: {
        to: {
          href: `/api/v3/work_packages/${toId}`,
        },
      },
    };

    // The correct endpoint is /api/v3/work_packages/{id}/relations
    const response = await openProjectApi.post(
      `/work_packages/${fromId}/relations`,
      payload
    );
    console.log(`Created ${type} relationship: ${fromId} -> ${toId}`);
    stats.created++;
  } catch (error) {
    console.error(
      `Error creating relationship: ${fromId} -> ${toId} ${type} ${error.message}`
    );
    if (error.response?.data) {
      console.error(
        "Error details:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    stats.failed++;
  }
}

async function handleRelationships(issue) {
  const epicLinkField = await getEpicLinkFieldId();
  const epicLinkValue = issue.fields[epicLinkField];

  const linkCount = issue.fields.issuelinks?.length || 0;
  const firstLinkKey = linkCount > 0
    ? (issue.fields.issuelinks[0].outwardIssue?.key || issue.fields.issuelinks[0].inwardIssue?.key || "?")
    : "none";
  console.log(`handleRelationships for ${issue.key}: ${linkCount} issuelinks, first: ${firstLinkKey}, epic: ${epicLinkValue || "none"}, inMapping: ${issueToWorkPackageMap.has(issue.key)}`);

  if (!issue.fields.issuelinks && !epicLinkValue) return;

  const fromWorkPackageId = issueToWorkPackageMap.get(issue.key);
  if (!fromWorkPackageId) {
    console.warn(
      `Source issue ${issue.key} not found in work package mapping — skipping its relationships (${issue.fields.issuelinks?.length || 0} link(s), epic: ${!!epicLinkValue})`
    );
    return;
  }

  // Handle epic link first
  if (epicLinkValue) {
    const epicKey = epicLinkValue;
    const epicWorkPackageId = issueToWorkPackageMap.get(epicKey);
    if (epicWorkPackageId) {
      await createRelationship(fromWorkPackageId, epicWorkPackageId, "partof");
    } else {
      console.log(
        `Epic ${epicKey} not found in current migration batch, will retry later`
      );
      missingRelationships.add(
        JSON.stringify({
          fromKey: issue.key,
          toKey: epicKey,
          type: "partof",
        })
      );
    }
  }

  // Handle regular issue links
  if (!issue.fields.issuelinks || issue.fields.issuelinks.length === 0) return;

  for (const link of issue.fields.issuelinks) {
    let relatedIssueKey;
    let relationType;
    let shouldSkip = false;

    if (link.outwardIssue) {
      relatedIssueKey = link.outwardIssue.key;
      switch (link.type.outward) {
        case "blocks":
          relationType = "blocks";
          break;
        case "relates to":
          relationType = "relates";
          break;
        case "is parent of":
          relationType = "includes";
          break;
        case "duplicates":
          // For duplicates, only create the relationship if this is the newer issue
          relationType = "duplicates";
          // Skip if we've already processed this pair in the other direction
          shouldSkip = issue.fields.created > link.outwardIssue.fields?.created;
          break;
        default:
          relationType = "relates";
      }
    } else if (link.inwardIssue) {
      relatedIssueKey = link.inwardIssue.key;
      switch (link.type.inward) {
        case "is blocked by":
          relationType = "blocked";
          break;
        case "relates to":
          relationType = "relates";
          break;
        case "is child of":
          relationType = "partof";
          break;
        case "is duplicated by":
          // For duplicates, only create the relationship if this is the newer issue
          relationType = "duplicated";
          // Skip if we've already processed this pair in the other direction
          shouldSkip = issue.fields.created < link.inwardIssue.fields?.created;
          break;
        default:
          relationType = "relates";
      }
    }

    if (shouldSkip) {
      console.log(
        `Skipping duplicate relationship for ${issue.key} to avoid circular dependency`
      );
      continue;
    }

    const toWorkPackageId = issueToWorkPackageMap.get(relatedIssueKey);
    if (toWorkPackageId) {
      try {
        await createRelationship(
          fromWorkPackageId,
          toWorkPackageId,
          relationType
        );
      } catch (error) {
        console.error(
          `Failed to create relationship: ${issue.key} ${relationType} ${relatedIssueKey}`
        );
        // Store failed relationship to retry
        missingRelationships.add(
          JSON.stringify({
            fromKey: issue.key,
            toKey: relatedIssueKey,
            type: relationType,
          })
        );
      }
    } else {
      console.log(
        `Skipping relationship: Target issue ${relatedIssueKey} not found in current migration batch`
      );
      // Store missing relationship to retry
      missingRelationships.add(
        JSON.stringify({
          fromKey: issue.key,
          toKey: relatedIssueKey,
          type: relationType,
        })
      );
    }
  }
}

async function retryMissingRelationships() {
  if (missingRelationships.size === 0) return;

  let iteration = 0;
  const maxIterations = 5;

  while (missingRelationships.size > 0 && iteration < maxIterations) {
    iteration++;
    const retryBatch = Array.from(missingRelationships).map((r) =>
      JSON.parse(r)
    );
    missingRelationships.clear();

    const beforeCount = retryBatch.length;
    let resolved = 0;

    console.log(
      `\nRetry pass ${iteration}: ${retryBatch.length} missing relationships...`
    );

    for (const rel of retryBatch) {
      const fromWorkPackageId = issueToWorkPackageMap.get(rel.fromKey);
      const toWorkPackageId = issueToWorkPackageMap.get(rel.toKey);

      if (fromWorkPackageId && toWorkPackageId) {
        try {
          await createRelationship(
            fromWorkPackageId,
            toWorkPackageId,
            rel.type
          );
          resolved++;
        } catch (error) {
          console.error(
            `Failed to create relationship: ${rel.fromKey} ${rel.type} ${rel.toKey}: ${error.message}`
          );
          missingRelationships.add(JSON.stringify(rel));
        }
      } else {
        missingRelationships.add(JSON.stringify(rel));
      }
    }

    console.log(
      `Retry pass ${iteration}: resolved ${resolved}, still missing ${missingRelationships.size}`
    );

    if (resolved === 0 && missingRelationships.size > 0) {
      console.log(
        "No progress made — giving up on remaining relationships"
      );
      break;
    }
  }

  if (missingRelationships.size > 0) {
    const trueFailures = [];
    for (const rel of Array.from(missingRelationships).map((r) =>
      JSON.parse(r)
    )) {
      const fromId = issueToWorkPackageMap.get(rel.fromKey);
      const toId = issueToWorkPackageMap.get(rel.toKey);
      if (fromId && !toId) {
        try {
          const searchRes = await openProjectApi.get("/work_packages", {
            params: {
              filters: JSON.stringify([{ [`cf_${JIRA_ID_CUSTOM_FIELD}`]: { operator: "=", values: [rel.toKey] } }]),
              pageSize: 1,
            },
          });
          const foundWp = searchRes.data._embedded?.elements?.[0];
          if (foundWp) {
            const exists = await checkExistingRelationship(fromId, foundWp.id, rel.type);
            if (exists) continue;
          }
        } catch (_) {}
      }
      trueFailures.push(rel);
    }
    missingRelationships.clear();
    for (const rel of trueFailures) {
      missingRelationships.add(JSON.stringify(rel));
    }
    if (trueFailures.length > 0) {
      console.log(
        `\n=== ${trueFailures.length} relationships could not be created ===`
      );
      for (const rel of trueFailures) {
        console.log(
          `  FAILED: ${rel.fromKey} ${rel.type} ${rel.toKey} (fromWP: ${issueToWorkPackageMap.has(rel.fromKey)}, toWP: ${issueToWorkPackageMap.has(rel.toKey)})`
        );
      }
    }
  }
}

async function createRelationships(issues, issueKeyToWorkPackageIdMap) {
  try {
    console.log("\n=== Creating Relationships ===");
    console.log(`Mapping has ${Object.keys(issueKeyToWorkPackageIdMap).length} entries`);
    console.log("Sample mapping entries:", JSON.stringify(Object.entries(issueKeyToWorkPackageIdMap).slice(0, 3)));

    // Update the mapping with provided data
    for (const [key, id] of Object.entries(issueKeyToWorkPackageIdMap)) {
      issueToWorkPackageMap.set(key, id);
    }

    // Reset stats
    stats = { created: 0, skippedExisting: 0, skippedParent: 0, failed: 0, missing: 0, total: issues.length };

    // First pass: Create all relationships
    for (let i = 0; i < issues.length; i++) {
      await handleRelationships(issues[i]);
      if ((i + 1) % 500 === 0) {
        console.log(`Progress: ${i + 1}/${issues.length} issues (created: ${stats.created}, skipped: ${stats.skippedExisting}, failed: ${stats.failed})`);
      }
    }

    // Final pass: Retry any missing relationships
    await retryMissingRelationships();

    console.log("\n=== Relationship Summary ===");
    console.log(`  Created:  ${stats.created}`);
    console.log(`  Skipped:  ${stats.skippedExisting} (already exists)`);
    console.log(`  Failed:   ${stats.failed}`);
    console.log(`  Missing:  ${missingRelationships.size}`);
    console.log("================================");
    console.log("\n=== Relationship Migration Complete ===");
  } catch (error) {
    console.error("\nRelationship creation failed:", error.message);
  }
}

module.exports = { createRelationships };
