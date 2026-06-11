require("dotenv").config();
require("./logger");
const { getAllJiraIssues, getSpecificJiraIssues } = require("./jira-client");
const {
  getOpenProjectWorkPackages,
  setParentWorkPackage,
  listProjects,
  JIRA_ID_CUSTOM_FIELD,
} = require("./openproject-client");

async function migrateParents(jiraProjectKey, openProjectId, specificIssues) {
  console.log("Starting parent relationship migration...");

  // List available projects
  await listProjects();

  // Get work packages from OpenProject
  console.log(`\nFetching work packages for project ${openProjectId}...`);
  const workPackages = await getOpenProjectWorkPackages(openProjectId);

  // Create a map of Jira keys to work package IDs
  const jiraKeyToWorkPackageId = new Map();
  const jiraIdField = JIRA_ID_CUSTOM_FIELD;
  workPackages.forEach((wp) => {
    const jiraKey = jiraIdField ? wp[`customField${jiraIdField}`] : null;
    if (jiraKey) {
      jiraKeyToWorkPackageId.set(jiraKey, wp.id);
    }
  });

  console.log("\nCache Summary:");
  console.log(`- Total work packages: ${workPackages.length}`);
  console.log(`- Work packages with Jira ID: ${jiraKeyToWorkPackageId.size}`);
  console.log(
    `- Work packages without Jira ID: ${
      workPackages.length - jiraKeyToWorkPackageId.size
    }`
  );
  console.log(
    `- Cached ${jiraKeyToWorkPackageId.size} work packages for quick lookup`
  );
  console.log("=======================================\n");

  // Get Jira issues
  const jiraIssues = specificIssues
    ? await getSpecificJiraIssues(jiraProjectKey, specificIssues.split(","))
    : await getAllJiraIssues(jiraProjectKey);

  console.log(`Found ${jiraIssues.length} Jira issues to process`);

  // Process each issue
  let processed = 0;
  let completed = 0;
  let skipped = 0;
  let errors = 0;

  const totalIssues = jiraIssues.length;
  for (const issue of jiraIssues) {
    try {
      if (processed % 500 === 0) {
        console.log(`Progress: ${processed}/${totalIssues} issues (completed: ${completed}, skipped: ${skipped}, errors: ${errors})`);
      }
      const parentKey = issue.fields.parent?.key;
      if (!parentKey) {
        console.log(`No parent found for ${issue.key}`);
        skipped++;
        continue;
      }

      console.log(`Found parent ${parentKey} for ${issue.key}`);

      // Get the work package IDs
      const workPackageId = jiraKeyToWorkPackageId.get(issue.key);
      const parentWorkPackageId = jiraKeyToWorkPackageId.get(parentKey);

      if (!workPackageId || !parentWorkPackageId) {
        console.error(
          `Could not find work package IDs for ${issue.key} or its parent ${parentKey}`
        );
        errors++;
        continue;
      }

      try {
        await setParentWorkPackage(workPackageId, parentWorkPackageId);
        console.log(`Set parent relationship: ${issue.key} -> ${parentKey}`);
        completed++;
      } catch (error) {
        console.error(`Error setting parent for ${issue.key}:`, error.message);
        errors++;
      }
    } catch (error) {
      console.error(`Error processing ${issue.key}:`, error.message);
      if (error.response?.data) {
        console.error(
          "Error details:",
          JSON.stringify(error.response.data, null, 2)
        );
      }
      errors++;
    }
    processed++;
  }

  // Print summary
  console.log("\n=== Parent Migration Summary ===");
  console.log(`Total issues processed: ${processed} / ${totalIssues}`);
  console.log(`Completed: ${completed}`);
  console.log(`Skipped (no parent): ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log("===============================\n");
}

// Only auto-run when executed directly (not when imported)
if (require.main === module) {
  const jiraProjectKey = process.argv[2];
  const openProjectId = process.argv[3];
  const specificIssues = process.argv[4];

  if (!jiraProjectKey || !openProjectId) {
    console.error("Please provide a Jira project key and OpenProject ID");
    console.log(
      "Usage: node migrate-parents.js PROJECT_KEY PROJECT_ID [ISSUE_KEYS]"
    );
    process.exit(1);
  }

  migrateParents(jiraProjectKey, openProjectId, specificIssues);
}

module.exports = { migrateParents };
