require("dotenv").config();
const axios = require("axios");
const { getAllJiraIssues, getSpecificJiraIssues } = require("./jira-client");
const customFieldMapping = require("./custom-field-mapping");
const { extractJiraValue } = require("./index");

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

async function getWorkPackagesByProject(projectId) {
  let allWps = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const res = await openProjectApi.get("/work_packages", {
      params: {
        filters: JSON.stringify([
          { project: { operator: "=", values: [String(projectId)] } },
        ]),
        pageSize,
        offset: page,
        sortBy: JSON.stringify([["createdAt", "asc"]]),
      },
    });

    const elements = res.data._embedded.elements;
    if (!elements || elements.length === 0) break;

    allWps = allWps.concat(elements);
    console.log(`Fetched ${allWps.length} / ${res.data.total} WPs`);
    page++;
  }
  return allWps;
}

async function updateWorkPackage(wpId, payload) {
  const current = await openProjectApi.get(`/work_packages/${wpId}`);
  const { _type, ...updatePayload } = payload;
  updatePayload.lockVersion = current.data.lockVersion;
  await openProjectApi.patch(`/work_packages/${wpId}`, updatePayload);
}

async function getJiraCustomFieldValue(jiraKey, jiraField, jiraProjectKey) {
  const issues = await getSpecificJiraIssues(jiraProjectKey, [jiraKey], jiraField);
  if (issues && issues.length > 0 && issues[0].fields) {
    return issues[0].fields[jiraField];
  }
  return null;
}

async function main() {
  const rmProjectId = parseInt(process.argv[2] || "27", 10);
  const jiraProjectKey = process.argv[3] || process.env.JIRA_PROJECT_KEY || "RM";

  console.log(`Fetching work packages for project ${rmProjectId}...`);
  const wps = await getWorkPackagesByProject(rmProjectId);
  console.log(`Found ${wps.length} work packages`);

  const affected = wps.filter(
    (wp) => wp.customField22 === "[object Object]"
  );

  if (affected.length === 0) {
    console.log("\nNo work packages with '[object Object]' found.");
    return;
  }

  console.log(
    `\nFound ${affected.length} work package(s) with '[object Object]':`
  );
  for (const wp of affected) {
    console.log(`  WP ${wp.id}: "${wp.subject}" (Jira: ${wp.customField1})`);
  }

  const mappingEntry = customFieldMapping.find(
    (m) => m.openProjectField === 22
  );
  if (!mappingEntry) {
    console.error("Mapping for customField22 not found!");
    process.exit(1);
  }
  const jiraField = mappingEntry.jiraField;

  for (const wp of affected) {
    const jiraKey = wp.customField1;
    if (!jiraKey) {
      console.log(`\nSkipping WP ${wp.id}: no Jira ID found`);
      continue;
    }

    console.log(`\nProcessing WP ${wp.id} (${jiraKey})...`);
    console.log(`  Fetching Jira field ${jiraField}...`);

    const rawVal = await getJiraCustomFieldValue(jiraKey, jiraField, jiraProjectKey);

    if (rawVal === undefined || rawVal === null) {
      console.log(`  Could not get Jira value, skipping`);
      continue;
    }

    const val = extractJiraValue(rawVal);
    if (!val || val === "" || val === "[object Object]") {
      console.log(`  Extracted value is empty or still invalid, skipping`);
      continue;
    }

    console.log(`  Correct value: ${val}`);
    console.log(`  Updating WP ${wp.id}...`);
    await updateWorkPackage(wp.id, {
      customField22: String(val),
    });
    console.log(`  Updated WP ${wp.id}`);
  }

  console.log("\nDone.");
}

main().catch(console.error);
