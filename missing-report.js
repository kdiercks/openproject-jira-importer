require("dotenv").config();
require("./logger");
const fs = require("fs");
const path = require("path");
const { getAllJiraIssues } = require("./jira-client");
const {
  getAllWorkPackages,
  requireJiraIdField,
} = require("./openproject-client");

function naturalKeySort(first, second) {
  return first.localeCompare(second, undefined, { numeric: true });
}

async function findMissingJiraCases(jiraProjectKey, openProjectId) {
  const jiraIdField = requireJiraIdField();
  const [jiraIssues, workPackages] = await Promise.all([
    getAllJiraIssues(jiraProjectKey),
    getAllWorkPackages(openProjectId),
  ]);

  const openProjectKeys = new Set(
    workPackages
      .map((workPackage) => workPackage[`customField${jiraIdField}`])
      .filter(Boolean)
  );

  const missing = jiraIssues
    .filter((issue) => !openProjectKeys.has(issue.key))
    .map((issue) => issue.key)
    .sort(naturalKeySort);

  return {
    jiraCount: jiraIssues.length,
    openProjectCount: workPackages.length,
    mappedCount: openProjectKeys.size,
    missing,
  };
}

async function writeMissingReport(
  jiraProjectKey,
  openProjectId,
  outputFile = "missing.txt"
) {
  console.log(
    `\nChecking which Jira cases from ${jiraProjectKey} are missing in OpenProject project ${openProjectId}...`
  );

  const result = await findMissingJiraCases(jiraProjectKey, openProjectId);
  const targetPath = path.resolve(process.cwd(), outputFile);
  const content = result.missing.length
    ? `${result.missing.join("\n")}\n`
    : "";

  fs.writeFileSync(targetPath, content, "utf8");

  console.log(`Jira cases: ${result.jiraCount}`);
  console.log(`OpenProject work packages: ${result.openProjectCount}`);
  console.log(`Jira keys found in OpenProject: ${result.mappedCount}`);
  console.log(`Missing Jira cases: ${result.missing.length}`);
  console.log(`Report written to ${targetPath}`);

  return { ...result, outputFile: targetPath };
}

if (require.main === module) {
  const jiraProjectKey = process.argv[2];
  const openProjectId = parseInt(process.argv[3], 10);
  const outputFile = process.argv[4] || "missing.txt";

  if (!jiraProjectKey || Number.isNaN(openProjectId)) {
    console.log(
      "Usage: node missing-report.js JIRA_PROJECT_KEY OPENPROJECT_ID [OUTPUT_FILE]"
    );
    console.log("Example: node missing-report.js PS 49 missing.txt");
    process.exit(1);
  }

  writeMissingReport(jiraProjectKey, openProjectId, outputFile).catch((error) => {
    console.error(`Missing case report failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { findMissingJiraCases, writeMissingReport };
