require("dotenv").config();
const axios = require("axios");
const { getAllJiraIssues, buildDefaultFieldString } = require("./jira-client");
const { JIRA_ID_CUSTOM_FIELD } = require("./openproject-client");

const openProjectApi = axios.create({
  baseURL: `${process.env.OPENPROJECT_HOST}/api/v3`,
  headers: {
    Authorization: `Basic ${Buffer.from(
      `apikey:${process.env.OPENPROJECT_API_KEY}`
    ).toString("base64")}`,
    "Content-Type": "application/json",
  },
});

async function getAllWorkPackages(projectId) {
  let all = [];
  let page = 1;
  while (true) {
    const res = await openProjectApi.get("/work_packages", {
      params: {
        filters: JSON.stringify([{ project: { operator: "=", values: [projectId.toString()] } }]),
        pageSize: 100,
        offset: page,
        sortBy: JSON.stringify([["createdAt", "asc"]]),
      },
    });
    const wps = res.data._embedded.elements;
    if (!wps || wps.length === 0) break;
    all = all.concat(wps);
    if (all.length >= parseInt(res.data.total)) break;
    page++;
  }
  return all;
}

async function setJiraId(wpId, jiraId, lockVersion) {
  const jiraIdField = JIRA_ID_CUSTOM_FIELD;
  try {
    await openProjectApi.patch(`/work_packages/${wpId}`, {
      lockVersion,
      [`customField${jiraIdField}`]: jiraId,
    });
    return true;
  } catch (e) {
    console.error(`  FAILED WP ${wpId}: ${e.message}`);
    return false;
  }
}

async function main(jiraProjectKey, openProjectId) {
  console.log("Fetching Jira issues...");
  const fields = await buildDefaultFieldString();
  const jiraIssues = await getAllJiraIssues(jiraProjectKey, fields);
  const subjectToKey = new Map();
  for (const issue of jiraIssues) {
    if (issue.fields.summary) subjectToKey.set(issue.fields.summary, issue.key);
  }
  console.log(`Fetched ${jiraIssues.length} Jira issues`);

  console.log("Fetching OpenProject work packages...");
  const wps = await getAllWorkPackages(openProjectId);
  const jiraIdField = JIRA_ID_CUSTOM_FIELD;
  const withoutId = wps.filter(wp => !wp[`customField${jiraIdField}`]);
  console.log(`Found ${wps.length} WPs, ${withoutId.length} without Jira ID`);

  let success = 0;
  for (const wp of withoutId) {
    const jiraKey = subjectToKey.get(wp.subject);
    if (jiraKey) {
      process.stdout.write(`Setting ${jiraKey} on WP ${wp.id} (${wp.subject.slice(0, 50)})... `);
      if (await setJiraId(wp.id, jiraKey, wp.lockVersion)) {
        console.log("OK");
        success++;
      }
    } else {
      console.log(`No Jira match for WP ${wp.id}: "${wp.subject}"`);
    }
  }
  console.log(`\nDone: ${success}/${withoutId.length} set successfully`);
}

const key = process.argv[2];
const id = process.argv[3];
if (!key || !id) {
  console.log("Usage: node set-missing-jira-ids.js JIRA_KEY OPENPROJECT_ID");
  process.exit(1);
}
main(key, parseInt(id));
