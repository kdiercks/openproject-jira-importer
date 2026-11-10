require("dotenv").config();
const axios = require("axios");
const fs = require("fs");

/*
 * List all projects and their case/issue types from Jira (source) and
 * OpenProject (destination), or map the Jira issue types of one project
 * to the work package types of one OpenProject project.
 *
 * Usage:
 *   node list-catalog.js
 *   node list-catalog.js --jira-project KEY --openproject-project ID
 *   node list-catalog.js --json [path]
 *   node list-catalog.js --csv [path]
 *   node list-catalog.js --json catalog.json --csv catalog.csv
 */

const jiraApi = axios.create({
  baseURL: `https://${process.env.JIRA_HOST}/rest/api/3`,
  auth: {
    username: process.env.JIRA_EMAIL,
    password: process.env.JIRA_API_TOKEN,
  },
});

const openProjectApi = axios.create({
  baseURL: `${process.env.OPENPROJECT_HOST}/api/v3`,
  headers: {
    Authorization: `Basic ${Buffer.from(
      `apikey:${process.env.OPENPROJECT_API_KEY}`
    ).toString("base64")}`,
    "Content-Type": "application/json",
  },
});

function parseArgs(argv) {
  const options = {
    json: null,
    csv: null,
    help: false,
    jiraProject: null,
    openProjectProject: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--jira-project" || arg.startsWith("--jira-project=")) {
      if (arg.includes("=")) {
        options.jiraProject = arg.slice(arg.indexOf("=") + 1) || null;
      } else if (argv[i + 1] && !argv[i + 1].startsWith("-")) {
        options.jiraProject = argv[++i];
      }
      continue;
    }

    if (
      arg === "--openproject-project" ||
      arg.startsWith("--openproject-project=")
    ) {
      if (arg.includes("=")) {
        options.openProjectProject = arg.slice(arg.indexOf("=") + 1) || null;
      } else if (argv[i + 1] && !argv[i + 1].startsWith("-")) {
        options.openProjectProject = argv[++i];
      }
      continue;
    }

    if (arg === "--json" || arg.startsWith("--json=")) {
      if (arg.includes("=")) {
        options.json = arg.slice(arg.indexOf("=") + 1) || "catalog.json";
      } else if (argv[i + 1] && !argv[i + 1].startsWith("-")) {
        options.json = argv[++i];
      } else {
        options.json = "catalog.json";
      }
      continue;
    }

    if (arg === "--csv" || arg.startsWith("--csv=")) {
      if (arg.includes("=")) {
        options.csv = arg.slice(arg.indexOf("=") + 1) || "catalog.csv";
      } else if (argv[i + 1] && !argv[i + 1].startsWith("-")) {
        options.csv = argv[++i];
      } else {
        options.csv = "catalog.csv";
      }
      continue;
    }

    console.warn(`Ignoring unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`
List all Jira and OpenProject projects and their case types.

Usage:
  node list-catalog.js [options]
  node list-catalog.js --jira-project KEY --openproject-project ID [options]

Options:
  --jira-project KEY         Jira project key for type mapping
  --openproject-project ID   OpenProject project ID or identifier for type mapping
  --json [path]              Write the result as JSON (default: catalog.json)
  --csv [path]               Write the result as CSV (default: catalog.csv)
  --help, -h                 Show this help

Without project arguments the tool lists all projects and their types.
With both project arguments it maps every Jira issue type to the
OpenProject type using type-mapping.js, a case-insensitive name match,
or the same Task/first-type fallback as the migration.

The tool uses the credentials from your .env file:
  JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN
  OPENPROJECT_HOST, OPENPROJECT_API_KEY
`);
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error("Missing required environment variables:");
    for (const name of missing) {
      console.error(`- ${name}`);
    }
    console.error("\nConfigure them in your .env file (see .env.example).");
    process.exit(1);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error) {
  if (error.response) {
    return `HTTP ${error.response.status}: ${JSON.stringify(
      error.response.data
    )}`;
  }
  return error.message;
}

async function fetchJiraProjects() {
  const response = await jiraApi.get("/project");
  return Array.isArray(response.data) ? response.data : [];
}

async function fetchJiraProjectTypes(projectKey) {
  const response = await jiraApi.get(
    `/project/${encodeURIComponent(projectKey)}`
  );
  const issueTypes = response.data.issueTypes || [];
  return issueTypes.map((type) => ({
    id: type.id,
    name: type.name,
  }));
}

async function fetchJiraProject(projectKey) {
  const response = await jiraApi.get(
    `/project/${encodeURIComponent(projectKey)}`
  );
  const project = response.data;
  const issueTypes = project.issueTypes || [];
  return {
    key: project.key,
    id: project.id,
    name: project.name,
    types: issueTypes.map((type) => ({
      id: type.id,
      name: type.name,
    })),
  };
}

async function fetchJiraCatalog() {
  const projects = await fetchJiraProjects();
  const catalog = [];

  for (const project of projects) {
    try {
      const types = await fetchJiraProjectTypes(project.key);
      catalog.push({
        key: project.key,
        id: project.id,
        name: project.name,
        types,
      });
    } catch (error) {
      console.warn(
        `Warning: could not fetch issue types for Jira project ${project.key}: ${describeError(
          error
        )}`
      );
      catalog.push({
        key: project.key,
        id: project.id,
        name: project.name,
        types: [],
      });
    }

    await delay(100);
  }

  return catalog;
}

async function fetchOpenProjectCollection(url) {
  const elements = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await openProjectApi.get(nextUrl);
    const page = response.data?._embedded?.elements || [];
    elements.push(...page);
    nextUrl = response.data?._links?.nextBy?.href || null;
  }

  return elements;
}

async function fetchOpenProjectProjectTypes(projectId) {
  const types = await fetchOpenProjectCollection(
    `/projects/${projectId}/types`
  );
  return types.map((type) => ({
    id: type.id,
    name: type.name,
  }));
}

function loadTypeMapping() {
  try {
    const mapping = require("./type-mapping");
    if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
      return mapping;
    }
  } catch (error) {
    console.warn(`Warning: could not load type-mapping.js: ${error.message}`);
  }
  return {};
}

function loadProjectMapping() {
  try {
    const mapping = require("./project-mapping");
    if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
      return mapping;
    }
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") {
      console.warn(
        `Warning: could not load project-mapping.js: ${error.message}`
      );
    }
  }
  return {};
}

function getProjectMappingValue(projectMapping, jiraProjectKey) {
  const key = jiraProjectKey.toLowerCase();
  for (const [mappedKey, value] of Object.entries(projectMapping)) {
    if (mappedKey.toLowerCase() === key) {
      return value;
    }
  }
  return undefined;
}

function resolveOpenProjectFromCatalog(value, projects) {
  const text = String(value);
  const byId = projects.find((project) => String(project.id) === text);
  if (byId) {
    return byId;
  }

  return (
    projects.find(
      (project) =>
        (project.identifier || "").toLowerCase() === text.toLowerCase()
    ) || null
  );
}

async function resolveOpenProjectProject(value) {
  const projects = await fetchOpenProjectCollection(
    "/projects?pageSize=500"
  );
  const byId = projects.find(
    (project) => String(project.id) === String(value)
  );
  if (byId) {
    return byId;
  }

  const byIdentifier = projects.find(
    (project) =>
      (project.identifier || "").toLowerCase() === String(value).toLowerCase()
  );
  if (byIdentifier) {
    return byIdentifier;
  }

  throw new Error(
    `OpenProject project "${value}" not found by ID or identifier.`
  );
}

function resolveTypeMapping(jiraType, openProjectTypes, typeMapping) {
  let requestedType;
  let source;

  if (typeMapping[jiraType.name]) {
    requestedType = typeMapping[jiraType.name];
    source = "override";
  } else {
    const match = openProjectTypes.find(
      (type) => type.name.toLowerCase() === jiraType.name.toLowerCase()
    );
    if (match) {
      requestedType = match.name;
      source = "auto";
    } else {
      requestedType = "Task";
      source = "default";
    }
  }

  const target = openProjectTypes.find(
    (type) => type.name.toLowerCase() === requestedType.toLowerCase()
  );
  if (target) {
    return {
      openProjectTypeId: target.id,
      openProjectType: target.name,
      mapping: source,
      requestedType,
    };
  }

  const fallback = openProjectTypes[0];
  if (!fallback) {
    throw new Error("OpenProject project has no work package types.");
  }

  return {
    openProjectTypeId: fallback.id,
    openProjectType: fallback.name,
    mapping: "fallback",
    requestedType,
  };
}

function buildTypeMapping(jiraProject, openProjectProject, openProjectTypes) {
  const typeMapping = loadTypeMapping();
  const mappings = jiraProject.types.map((jiraType) => ({
    jiraTypeId: jiraType.id,
    jiraType: jiraType.name,
    ...resolveTypeMapping(jiraType, openProjectTypes, typeMapping),
  }));

  const usedTypeIds = new Set(
    mappings.map((mapping) => String(mapping.openProjectTypeId))
  );
  const unusedMappings = openProjectTypes
    .filter((type) => !usedTypeIds.has(String(type.id)))
    .map((type) => ({
      jiraTypeId: null,
      jiraType: null,
      openProjectTypeId: type.id,
      openProjectType: type.name,
      mapping: "unused",
      requestedType: null,
    }));

  return {
    jiraProject: {
      key: jiraProject.key,
      id: jiraProject.id,
      name: jiraProject.name,
    },
    openprojectProject: {
      id: openProjectProject.id,
      identifier: openProjectProject.identifier,
      name: openProjectProject.name,
    },
    mappings: mappings.concat(unusedMappings),
  };
}

const MAPPING_COLUMNS = [
  "jira_project_id",
  "jira_project_key",
  "jira_project_name",
  "openproject_project_id",
  "openproject_key",
  "openproject_project_name",
  "jira_typename",
  "jira_type_id",
  "openproject_typename",
  "openproject_typeid",
];

function buildMappingRows(result) {
  return result.mappings.map((mapping) => [
    result.jiraProject.id,
    result.jiraProject.key,
    result.jiraProject.name,
    result.openprojectProject.id,
    result.openprojectProject.identifier ?? "",
    result.openprojectProject.name,
    mapping.jiraType ?? "",
    mapping.jiraTypeId ?? "",
    mapping.openProjectType,
    mapping.openProjectTypeId,
  ]);
}

function jiraOnlyRow(jiraProject, type) {
  return [
    jiraProject.id,
    jiraProject.key,
    jiraProject.name,
    "",
    "",
    "",
    type ? type.name : "",
    type ? type.id : "",
    "",
    "",
  ];
}

function openProjectOnlyRow(openProjectProject, type) {
  return [
    "",
    "",
    "",
    openProjectProject.id,
    openProjectProject.identifier ?? "",
    openProjectProject.name,
    "",
    "",
    type ? type.name : "",
    type ? type.id : "",
  ];
}

function combinedRow(jiraProject, openProjectProject, jiraType, resolved) {
  return [
    jiraProject.id,
    jiraProject.key,
    jiraProject.name,
    openProjectProject.id,
    openProjectProject.identifier ?? "",
    openProjectProject.name,
    jiraType.name,
    jiraType.id,
    resolved.openProjectType,
    resolved.openProjectTypeId,
  ];
}

function buildCatalogRows(catalog, projectMapping) {
  const typeMapping = loadTypeMapping();
  const rows = [];
  const pairedOpenProjectIds = new Set();
  const stats = {
    pairedProjects: 0,
    unpairedJiraProjects: 0,
    unpairedOpenProjectProjects: 0,
    mappingCounts: {},
  };

  for (const jiraProject of catalog.jira.projects) {
    const mappedValue = getProjectMappingValue(
      projectMapping,
      jiraProject.key
    );
    let openProjectProject = null;

    if (mappedValue !== undefined) {
      openProjectProject = resolveOpenProjectFromCatalog(
        mappedValue,
        catalog.openproject.projects
      );
      if (!openProjectProject) {
        console.warn(
          `Warning: project-mapping.js maps ${jiraProject.key} to "${mappedValue}", but no OpenProject project was found by ID or identifier.`
        );
      }
    }

    if (!openProjectProject) {
      stats.unpairedJiraProjects++;
      if (jiraProject.types.length === 0) {
        rows.push(jiraOnlyRow(jiraProject, null));
      }
      for (const type of jiraProject.types) {
        rows.push(jiraOnlyRow(jiraProject, type));
      }
      continue;
    }

    stats.pairedProjects++;
    pairedOpenProjectIds.add(String(openProjectProject.id));

    if (openProjectProject.types.length === 0) {
      console.warn(
        `Warning: OpenProject project ${openProjectProject.id} has no types; cannot map ${jiraProject.key}.`
      );
      for (const type of jiraProject.types) {
        rows.push(jiraOnlyRow(jiraProject, type));
      }
      continue;
    }

    const usedTypeIds = new Set();
    for (const jiraType of jiraProject.types) {
      const resolved = resolveTypeMapping(
        jiraType,
        openProjectProject.types,
        typeMapping
      );
      usedTypeIds.add(String(resolved.openProjectTypeId));
      stats.mappingCounts[resolved.mapping] =
        (stats.mappingCounts[resolved.mapping] || 0) + 1;

      if (resolved.mapping === "fallback") {
        console.warn(
          `Warning: ${jiraProject.key} ${jiraType.name} requested "${resolved.requestedType}", which is not available; using "${resolved.openProjectType}".`
        );
      }

      rows.push(
        combinedRow(jiraProject, openProjectProject, jiraType, resolved)
      );
    }

    for (const type of openProjectProject.types) {
      if (!usedTypeIds.has(String(type.id))) {
        stats.mappingCounts.unused =
          (stats.mappingCounts.unused || 0) + 1;
        rows.push(openProjectOnlyRow(openProjectProject, type));
      }
    }
  }

  for (const openProjectProject of catalog.openproject.projects) {
    if (pairedOpenProjectIds.has(String(openProjectProject.id))) {
      continue;
    }

    stats.unpairedOpenProjectProjects++;
    if (openProjectProject.types.length === 0) {
      rows.push(openProjectOnlyRow(openProjectProject, null));
    }
    for (const type of openProjectProject.types) {
      rows.push(openProjectOnlyRow(openProjectProject, type));
    }
  }

  return { rows, stats };
}

function printTypeMapping(result) {
  const { mappings } = result;

  if (mappings.length === 0) {
    console.log("\n(No Jira issue types found)");
    return;
  }

  const headers = MAPPING_COLUMNS;
  const rows = buildMappingRows(result);
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[index]).length)
    )
  );
  const formatRow = (row) =>
    row.map((value, index) => String(value).padEnd(widths[index])).join("  ");

  console.log("");
  console.log(formatRow(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  rows.forEach((row) => console.log(formatRow(row)));

  for (const mapping of mappings) {
    if (mapping.mapping === "fallback") {
      console.warn(
        `Warning: ${mapping.jiraType} requested "${mapping.requestedType}", which is not available; using "${mapping.openProjectType}".`
      );
    }
  }

  const counts = {};
  for (const mapping of mappings) {
    counts[mapping.mapping] = (counts[mapping.mapping] || 0) + 1;
  }
  const summary = ["override", "auto", "default", "fallback", "unused"]
    .filter((key) => counts[key])
    .map((key) => `${counts[key]} ${key}`)
    .join(", ");

  console.log(`\n${mappings.length} row(s): ${summary}`);
}

async function fetchOpenProjectCatalog() {
  const projects = await fetchOpenProjectCollection(
    "/projects?pageSize=500"
  );
  const catalog = [];

  for (const project of projects) {
    try {
      const types = await fetchOpenProjectProjectTypes(project.id);
      catalog.push({
        id: project.id,
        identifier: project.identifier,
        name: project.name,
        types,
      });
    } catch (error) {
      console.warn(
        `Warning: could not fetch types for OpenProject project ${project.id}: ${describeError(
          error
        )}`
      );
      catalog.push({
        id: project.id,
        identifier: project.identifier,
        name: project.name,
        types: [],
      });
    }

    await delay(100);
  }

  return catalog;
}

function printCatalogRows(rows, stats) {
  if (rows.length === 0) {
    console.log("(No projects found)");
    return;
  }

  const headers = MAPPING_COLUMNS;
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[index]).length)
    )
  );
  const formatRow = (row) =>
    row.map((value, index) => String(value).padEnd(widths[index])).join("  ");

  console.log("");
  console.log(formatRow(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  rows.forEach((row) => console.log(formatRow(row)));

  console.log(`\n${rows.length} row(s)`);
  console.log(`Paired projects: ${stats.pairedProjects}`);
  console.log(`Unpaired Jira projects: ${stats.unpairedJiraProjects}`);
  console.log(
    `Unpaired OpenProject projects: ${stats.unpairedOpenProjectProjects}`
  );

  const summary = ["override", "auto", "default", "fallback", "unused"]
    .filter((key) => stats.mappingCounts[key])
    .map((key) => `${stats.mappingCounts[key]} ${key}`)
    .join(", ");
  if (summary) {
    console.log(`Mapping: ${summary}`);
  }
}

function writeJson(data, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  console.log(`\nJSON written to ${filePath}`);
}

function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsvRows(rows, filePath) {
  const content = [MAPPING_COLUMNS, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
  fs.writeFileSync(filePath, content + "\n");
  console.log(`CSV written to ${filePath}`);
}

function writeMappingCsv(result, filePath) {
  writeCsvRows(buildMappingRows(result), filePath);
}

async function runTypeMapping(options) {
  console.log(`Fetching Jira project ${options.jiraProject}...`);
  const jiraProject = await fetchJiraProject(options.jiraProject);

  console.log(
    `Fetching OpenProject project ${options.openProjectProject}...`
  );
  const openProjectProject = await resolveOpenProjectProject(
    options.openProjectProject
  );
  const openProjectTypes = await fetchOpenProjectProjectTypes(
    openProjectProject.id
  );

  if (openProjectTypes.length === 0) {
    throw new Error(
      `OpenProject project ${openProjectProject.id} has no work package types.`
    );
  }

  const result = buildTypeMapping(
    jiraProject,
    openProjectProject,
    openProjectTypes
  );

  printTypeMapping(result);

  if (options.json) {
    writeJson(result, options.json);
  }
  if (options.csv) {
    writeMappingCsv(result, options.csv);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  requireEnv([
    "JIRA_HOST",
    "JIRA_EMAIL",
    "JIRA_API_TOKEN",
    "OPENPROJECT_HOST",
    "OPENPROJECT_API_KEY",
  ]);

  const hasJiraProject = Boolean(options.jiraProject);
  const hasOpenProjectProject = Boolean(options.openProjectProject);

  if (hasJiraProject !== hasOpenProjectProject) {
    console.error(
      "Both --jira-project and --openproject-project are required for type mapping."
    );
    printHelp();
    process.exit(1);
  }

  if (hasJiraProject && hasOpenProjectProject) {
    await runTypeMapping(options);
    return;
  }

  console.log("Fetching Jira projects and issue types...");
  const jiraProjects = await fetchJiraCatalog();

  console.log("Fetching OpenProject projects and types...");
  const openProjectProjects = await fetchOpenProjectCatalog();

  const catalog = {
    jira: { projects: jiraProjects },
    openproject: { projects: openProjectProjects },
  };

  const projectMapping = loadProjectMapping();
  const { rows, stats } = buildCatalogRows(catalog, projectMapping);

  printCatalogRows(rows, stats);

  if (options.json) {
    writeJson(catalog, options.json);
  }
  if (options.csv) {
    writeCsvRows(rows, options.csv);
  }
}

main().catch((error) => {
  console.error("Fatal error:", describeError(error));

  if (error.response?.status === 401) {
    console.error(
      "\nAuthentication failed. Check JIRA_EMAIL/JIRA_API_TOKEN or OPENPROJECT_API_KEY."
    );
  } else if (error.response?.status === 403) {
    console.error(
      "\nPermission denied. Make sure the API credentials can view projects and types."
    );
  }

  process.exit(1);
});
