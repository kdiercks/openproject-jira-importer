require("dotenv").config();
require("./logger");
const { createRelationships } = require("./create-relationships");
const {
  getAllJiraIssues,
  getSpecificJiraIssues,
  buildDefaultFieldString,
} = require("./jira-client");
const {
  getOpenProjectWorkPackages: getOpenProjectWorkPackagesFromClient,
} = require("./openproject-client");

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

async function getOpenProjectWorkPackages(projectIds) {
  const projectList = Array.isArray(projectIds) ? projectIds : [projectIds];
  const mapping = {};

  for (const id of projectList) {
    try {
      console.log(`Fetching work packages for project ${id}...`);
      const workPackagesMap = await getOpenProjectWorkPackagesFromClient(id);

      for (const [jiraId, wp] of workPackagesMap.entries()) {
        mapping[jiraId] = wp.id;
      }

      console.log(
        `  → ${workPackagesMap.size} mapped work packages from project ${id}`
      );
    } catch (error) {
      console.error(
        `Error fetching work packages for project ${id}:`,
        error.message
      );
    }
  }

  return mapping;
}

async function migrateRelationships(
  jiraProjectKey,
  openProjectId,
  specificIssues = null,
  extraProjectIds = []
) {
  try {
    console.log("\n=== Starting Relationship Migration ===");

    const allProjectIds = [openProjectId, ...extraProjectIds];
    const mapping = await getOpenProjectWorkPackages(allProjectIds);
    console.log(
      `\nTotal: ${Object.keys(mapping).length} mapped work packages across ${allProjectIds.length} project(s)`
    );

    // Get Jira issues with their relationships
    const fields = await buildDefaultFieldString();
    const issues = specificIssues
      ? await getSpecificJiraIssues(jiraProjectKey, specificIssues, fields)
      : await getAllJiraIssues(jiraProjectKey, fields);
    console.log(`Found ${issues.length} Jira issues to process`);

    // Create relationships
    await createRelationships(issues, mapping);
  } catch (error) {
    console.error("Migration failed:", error.message);
  }
}

// Only auto-run when executed directly (not when imported)
if (require.main === module) {
  const args = process.argv.slice(2);
  const extraIndex = args.indexOf("--extra-projects");
  const extraProjectIds =
    extraIndex !== -1
      ? args[extraIndex + 1].split(",").map((id) => parseInt(id.trim(), 10))
      : [];
  const jiraProjectKey = args[0];
  const openProjectId = parseInt(args[1]);
  const specificIssues = args[2] && !args[2].startsWith("--")
    ? args[2].split(",")
    : null;

  if (!jiraProjectKey || !openProjectId) {
    console.log(
      "Usage: node migrate-relationships.js JIRA_PROJECT_KEY OPENPROJECT_ID [ISSUE1,ISSUE2,...] [--extra-projects ID1,ID2,...]"
    );
    console.log("Example: node migrate-relationships.js CLAIRE 29");
    console.log(
      "Example with cross-project: node migrate-relationships.js CLAIRE 29 --extra-projects 27"
    );
    console.log(
      "Example with specific issues: node migrate-relationships.js CLAIRE 29 KEY-123,KEY-124"
    );
    process.exit(1);
  }

  migrateRelationships(jiraProjectKey, openProjectId, specificIssues, extraProjectIds);
}

module.exports = { migrateRelationships };
