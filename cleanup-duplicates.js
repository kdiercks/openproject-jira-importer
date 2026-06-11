require("dotenv").config();
const axios = require("axios");
const { getAllJiraIssues, buildDefaultFieldString } = require("./jira-client");
const { JIRA_ID_CUSTOM_FIELD } = require("./openproject-client");

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

async function getAllWorkPackages(projectId) {
  let allWorkPackages = [];
  let page = 1;
  const pageSize = 100;
  let total = null;

  while (true) {
    const response = await openProjectApi.get("/work_packages", {
      params: {
        filters: JSON.stringify([
          {
            project: {
              operator: "=",
              values: [projectId.toString()],
            },
          },
        ]),
        pageSize: pageSize,
        offset: page,
        sortBy: JSON.stringify([["createdAt", "asc"]]),
      },
    });

    if (total === null) {
      total = parseInt(response.data.total);
      console.log(`Total work packages to fetch: ${total}`);
    }

    const workPackages = response.data._embedded.elements;
    if (!workPackages || workPackages.length === 0) break;

    allWorkPackages = allWorkPackages.concat(workPackages);
    console.log(
      `Retrieved ${allWorkPackages.length} of ${total} work packages`
    );

    if (allWorkPackages.length >= total) break;
    page++;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return allWorkPackages;
}

async function deleteWorkPackage(workPackageId) {
  try {
    await openProjectApi.delete(`/work_packages/${workPackageId}`);
    return true;
  } catch (error) {
    console.error(
      `Error deleting work package ${workPackageId}:`,
      error.message
    );
    return false;
  }
}

async function updateWorkPackage(workPackageId, payload) {
  try {
    const currentWP = await openProjectApi.get(
      `/work_packages/${workPackageId}`
    );
    const response = await openProjectApi.patch(
      `/work_packages/${workPackageId}`,
      { ...payload, lockVersion: currentWP.data.lockVersion }
    );
    return response.data;
  } catch (error) {
    console.error(
      `Error updating work package ${workPackageId}:`,
      error.message
    );
    return null;
  }
}

async function cleanupDuplicates(jiraProjectKey, openProjectId) {
  console.log(`\n=== Cleaning up duplicates for ${jiraProjectKey} → project ${openProjectId} ===\n`);

  // 1. Fetch all Jira issues
  console.log("Fetching Jira issues...");
  const fields = await buildDefaultFieldString();
  const jiraIssues = await getAllJiraIssues(jiraProjectKey, fields);
  console.log(`Found ${jiraIssues.length} Jira issues`);

  // Build a map of subject → jiraKey
  const subjectToJiraKey = new Map();
  const jiraKeyToSubject = new Map();
  for (const issue of jiraIssues) {
    const summary = issue.fields.summary;
    if (summary) {
      subjectToJiraKey.set(summary, issue.key);
      jiraKeyToSubject.set(issue.key, summary);
    }
  }

  // 2. Fetch all OpenProject work packages
  console.log("\nFetching OpenProject work packages...");
  const workPackages = await getAllWorkPackages(openProjectId);
  console.log(`Found ${workPackages.length} work packages`);

  // 3. Group work packages by subject
  const bySubject = new Map();
  const withJiraId = [];
  const withoutJiraId = [];

  for (const wp of workPackages) {
    const jiraIdField = JIRA_ID_CUSTOM_FIELD;
    const jiraId = jiraIdField ? wp[`customField${jiraIdField}`] : null;
    if (jiraId) {
      withJiraId.push(wp);
    } else {
      withoutJiraId.push(wp);
      const subject = wp.subject || "";
      if (!bySubject.has(subject)) {
        bySubject.set(subject, []);
      }
      bySubject.get(subject).push(wp);
    }
  }

  console.log(`With Jira ID: ${withJiraId.length}`);
  console.log(`Without Jira ID: ${withoutJiraId.length}`);

  // 4. For subjects with duplicates, keep the oldest, delete the rest
  let deleted = 0;
  let idsSet = 0;
  let matched = 0;

  for (const [subject, wps] of bySubject.entries()) {
    if (wps.length === 0) continue;

    // Sort by creation date (oldest first)
    wps.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    // Keep the oldest (first), delete the rest
    const keep = wps[0];
    const toDelete = wps.slice(1);

    for (const wp of toDelete) {
      console.log(`Deleting duplicate WP ${wp.id} (${subject})`);
      await deleteWorkPackage(wp.id);
      deleted++;
    }

    // Try to match by subject and set Jira ID
    const jiraKey = subjectToJiraKey.get(subject);
    if (jiraKey) {
      console.log(`Setting Jira ID ${jiraKey} on WP ${keep.id} (${subject})`);
      const jiraIdField = JIRA_ID_CUSTOM_FIELD;
      if (jiraIdField) {
        const result = await updateWorkPackage(keep.id, {
          [`customField${jiraIdField}`]: jiraKey,
        });
        if (result) {
          idsSet++;
        }
      }
      matched++;
    }
  }

  // 5. Also handle work packages with Jira IDs that don't match the CLAIRE pattern
  // (e.g., if they have RM-100 as Jira ID but should be CLAIRE-xxx)
  for (const wp of withJiraId) {
    const jiraIdField = JIRA_ID_CUSTOM_FIELD;
    const currentId = jiraIdField ? wp[`customField${jiraIdField}`] : null;
    if (currentId && !currentId.startsWith(jiraProjectKey)) {
      // This WP has a Jira ID from a different project — try to fix it
      const subject = wp.subject || "";
      const correctKey = subjectToJiraKey.get(subject);
      if (correctKey && correctKey !== currentId) {
        console.log(
          `FIXING: WP ${wp.id} has Jira ID "${currentId}" but subject matches ${correctKey}`
        );
        const result = await updateWorkPackage(wp.id, {
          [`customField${jiraIdField}`]: correctKey,
        });
        if (result) idsSet++;
      }
    }
  }

  console.log(`\n=== Cleanup Complete ===`);
  console.log(`Deleted duplicates: ${deleted}`);
  console.log(`Set/matched Jira IDs: ${idsSet}`);
  console.log(`Subjects matched: ${matched}`);
}

// Parse command line arguments
const jiraProjectKey = process.argv[2];
const openProjectId = process.argv[3];

if (!jiraProjectKey || !openProjectId) {
  console.log("Usage: node cleanup-duplicates.js JIRA_PROJECT_KEY OPENPROJECT_ID");
  process.exit(1);
}

cleanupDuplicates(jiraProjectKey, parseInt(openProjectId));
