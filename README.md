# OpenProject Jira Migration Tool

A tool to migrate issues from Jira to OpenProject, including attachments, comments, relationships, and priorities.

## Features

- Migrates issues with their descriptions, priorities, and statuses
- Preserves issue relationships and hierarchies
- Migrates attachments and comments
- Migrates watchers
- Maps Jira users to OpenProject users
- Tracks original Jira issue IDs
- Handles incremental migrations
- Migrates XRay Cloud test steps to OpenProject Test Step work packages
- Links XRay Test Executions to their Tests and Test Plans
- Lists all projects and their case/issue types from both systems

## Prerequisites

1. Node.js installed
2. Access to both Jira and OpenProject instances
3. API tokens/keys for both systems
4. Custom field in OpenProject to store Jira issue IDs

## Setup

1. Clone this repository
2. Run `npm install` to install dependencies
3. Copy `.env.example` to `.env`
4. Configure your environment variables in `.env`

### Environment Variables

#### Jira Configuration
- `JIRA_HOST`: Your Jira instance hostname (e.g., your-domain.atlassian.net)
- `JIRA_EMAIL`: Your Jira email address
- `JIRA_API_TOKEN`: Your Jira API token (generate at https://id.atlassian.com/manage-profile/security/api-tokens)

#### Xray Cloud Configuration (optional)
Required only if you want to migrate test steps or link test executions.

- `XRAY_CLIENT_ID`: Xray Cloud API client ID (Xray > Settings > API Keys)
- `XRAY_CLIENT_SECRET`: Xray Cloud API client secret
- `XRAY_BASE_URL`: Optional Xray Cloud API base URL, defaults to `https://xray.cloud.getxray.app/api/v2`. Use the regional endpoint if your Xray instance requires it.

#### OpenProject Configuration
- `OPENPROJECT_HOST`: Your OpenProject instance URL
- `OPENPROJECT_API_KEY`: Your OpenProject API key (generate in Settings > My account > Access token)

#### Custom Field Configuration
- `JIRA_ID_CUSTOM_FIELD`: The ID of the custom field in OpenProject that stores the Jira issue ID
  - This must be a text custom field
  - Find the ID in OpenProject: Administration > Custom fields > Work packages
  - This variable is required — the migration will fail with a clear error if not set

#### Test Step Configuration (optional)
The following custom fields are used for XRay test steps and match the OpenProject test management defaults:

- `OPENPROJECT_TEST_STEP_ACTION_FIELD`: Default `24` (Test Step Description)
- `OPENPROJECT_TEST_STEP_EXPECTED_FIELD`: Default `25` (Test Step Expected)
- `OPENPROJECT_TEST_STEP_DATA_FIELD`: Default `26` (Test Step Data)
- `OPENPROJECT_TEST_RELATION_TYPE`: Relation type used for Test Execution → Test and Test Plan → Test Execution links. Default `includes`.

Test step content stays on the `Test Step` work package type. The migration does not move these custom fields to the `Test` type.

### OpenProject Custom Field Setup

1. In OpenProject, go to Administration > Custom fields > Work packages
2. Create a new text custom field (if not already exists)
3. Note the ID of the custom field
4. Set this ID in your `.env` file as `JIRA_ID_CUSTOM_FIELD`

## Configuration Files

The tool uses several JS config files to control how data maps between Jira and OpenProject. All are optional — built-in defaults are used for anything not configured.

### `custom-field-mapping.js`
Maps Jira custom fields to OpenProject custom fields.

```bash
# List available fields from both systems first:
node discover-custom-fields.js
```

Then edit `custom-field-mapping.js` to add entries:

```js
module.exports = [
  {
    jiraField: "customfield_12345",   // from Jira (or use field name, e.g. "Risk Level")
    openProjectField: 7,               // from OpenProject
    type: "list",                      // string | text | integer | float | date | boolean | list | multi_list | user
  },
];
```

See the file itself for all supported types and options.

### `type-mapping.js`
Maps Jira issue type names to OpenProject work package type names. Default:

```js
module.exports = {
  Task: "Task",
  Story: "User story",
  Bug: "Bug",
  Epic: "Epic",
  Feature: "Feature",
  Milestone: "Milestone",
  "Test Case": "Test",
};
```

### `status-mapping.js`
Maps Jira status names to OpenProject status names. Default:

```js
module.exports = {
  "To Do": "New",
  "In Progress": "In progress",
  Done: "Closed",
  Closed: "Closed",
  Resolved: "Closed",
};
```

### `priority-mapping.js`
Maps Jira priority names to OpenProject priority names. Default:

```js
module.exports = {
  Highest: "Immediate",
  High: "High",
  Medium: "Normal",
  Low: "Low",
  Lowest: "Low",
};
```

### `user-mapping.js` / `user-mapping.generated.js`
Maps Jira user account IDs to OpenProject user IDs.

```bash
# Interactive generation:
node generate-user-mapping.js
```

This writes `user-mapping.generated.js` (gitignored). The tool loads it automatically. Edit `user-mapping.js` to pre-configure mappings manually if preferred.

## Usage

Run the migration tool:

```bash
node migrate.js
```

Follow the interactive prompts to:
1. Select source Jira project
2. Select target OpenProject project
3. Choose migration type (full or specific issues)
4. Confirm existing issue handling

For non-interactive usage or specific issues:

```bash
# Migrate specific issues
node migrate.js JIRA_PROJECT_KEY OPENPROJECT_ID ISSUE1,ISSUE2

# Migrate relationships only
node migrate-relationships.js JIRA_PROJECT_KEY OPENPROJECT_ID

# Verify that XRay test steps exist in OpenProject (no changes)
node migrate-test-steps.js OPENPROJECT_ID --jira-project JIRA_PROJECT_KEY --verify

# Preview test step migration without writing anything
node migrate-test-steps.js OPENPROJECT_ID --jira-project JIRA_PROJECT_KEY --dry-run

# Migrate XRay test steps as child Test Step work packages
node migrate-test-steps.js OPENPROJECT_ID --jira-project JIRA_PROJECT_KEY

# Remove Test Step children that no longer exist in Xray
node migrate-test-steps.js OPENPROJECT_ID --jira-project JIRA_PROJECT_KEY --prune

# Verify that XRay execution and plan links exist (no changes)
node migrate-test-executions.js OPENPROJECT_ID --jira-project JIRA_PROJECT_KEY --verify

# Preview execution/test/plan link migration without writing anything
node migrate-test-executions.js OPENPROJECT_ID --jira-project JIRA_PROJECT_KEY --dry-run

# Link XRay Test Executions to their Tests and Test Plans
node migrate-test-executions.js OPENPROJECT_ID --jira-project JIRA_PROJECT_KEY

# Write all Jira cases that are missing in OpenProject to missing.txt
node missing-report.js JIRA_PROJECT_KEY OPENPROJECT_ID

# Or run the full migration including test steps and execution links
node migrate.js JIRA_PROJECT_KEY OPENPROJECT_ID --prod --test-management

# Migrate only execution links
node migrate.js JIRA_PROJECT_KEY OPENPROJECT_ID --prod --test-executions

# Migrate parent-child hierarchies only
node migrate-parents.js JIRA_PROJECT_KEY OPENPROJECT_ID [ISSUE1,ISSUE2]
```

The `migrate-parents.js` script specifically handles parent-child hierarchies from Jira to OpenProject. While `migrate-relationships.js` handles all types of relationships (blocks, relates, etc.), this script focuses only on the hierarchical structure.

Key features:
- Migrates Jira's parent-child relationships to OpenProject's hierarchical structure
- Can process specific issues or entire project
- Preserves existing work package data
- Shows detailed progress and results

Use this when:
- You need to fix hierarchy issues
- You want to migrate parent-child relationships separately
- You're troubleshooting hierarchy-specific problems

Note: Run this script before `migrate-relationships.js` as OpenProject doesn't allow both parent-child hierarchies and "partof"/"includes" relationships between the same work packages.

### Project and Type Catalog

`list-catalog.js` is read-only and uses the credentials from your `.env` file. Without arguments it lists every visible Jira project with its project-specific issue types and every OpenProject project with its available work package types.

```bash
# Print the catalog to the console
node list-catalog.js

# Also write a JSON file (default: catalog.json)
node list-catalog.js --json

# Also write a CSV file (default: catalog.csv)
node list-catalog.js --csv

# Custom output paths
node list-catalog.js --json reports/catalog.json --csv reports/catalog.csv

# Print the catalog to the console via npm
npm run catalog:list
```

The JSON output contains a `jira.projects` array (`key`, `id`, `name`, `types`) and an `openproject.projects` array (`id`, `identifier`, `name`, `types`). The catalog CSV uses the same columns as the mapping export (`jira_project_id` … `openproject_typeid`). If a project is paired via `project-mapping.js`, its Jira case types are emitted as combined Jira → OpenProject rows. Unpaired Jira and OpenProject projects remain one-sided with empty columns on the other side.

### Project Mapping

`project-mapping.js` assigns Jira project keys to OpenProject projects so the catalog can emit combined rows:

```js
module.exports = {
  AIC: 8,        // OpenProject project ID
  VSN: "VSN",    // or OpenProject identifier
};
```

For every mapped project, each Jira case type is resolved against the target project's work package types using the same rules as the migration (`type-mapping.js`, name match, `Task` fallback). Unused OpenProject types of a paired project are included with empty Jira columns. Projects without an entry remain one-sided; no automatic project pairing is performed.

### Source to Target Type Mapping

Pass a Jira project key and an OpenProject project ID (or identifier) to map every Jira issue type to the type that the migration would use in the target project:

```bash
node list-catalog.js --jira-project AIC --openproject-project 8

# With exports
node list-catalog.js --jira-project AIC --openproject-project AA \
  --json reports/type-mapping.json --csv reports/type-mapping.csv
```

The mapping follows the same rules as the migration:

1. `override` — an entry from `type-mapping.js`.
2. `auto` — case-insensitive name match with a type in the target project.
3. `default` — fallback to `Task` when no override or name match exists.
4. `fallback` — the requested type is not available in the target project, so the first available type is used (as in `getWorkPackageTypeId`).
5. `unused` — an OpenProject type that is not referenced by any Jira issue type. It is listed with empty Jira columns.

The console output and the CSV export use the same columns: `jira_project_id,jira_project_key,jira_project_name,openproject_project_id,openproject_key,openproject_project_name,jira_typename,jira_type_id,openproject_typename,openproject_typeid`. `openproject_key` is the OpenProject project identifier. One row is emitted per Jira issue type, even when the Jira and OpenProject type names are identical; unused OpenProject types follow with empty Jira columns. The mapping source is summarized below the console table. The JSON output contains `jiraProject`, `openprojectProject`, and a `mappings` array with `jiraTypeId`, `jiraType`, `openProjectTypeId`, `openProjectType`, `mapping`, and the originally requested type (`requestedType`). For `unused` entries the Jira fields and `requestedType` are `null`.

Use this before a migration to check which Jira issue types need an entry in `type-mapping.js` and which OpenProject types are available in the target project.

### XRay Test Steps

`migrate-test-steps.js` imports Manual and step-based test steps from XRay Cloud as child work packages of type `Test Step`:

- The parent `Test` work package is found via `JIRA_ID_CUSTOM_FIELD`.
- Step subjects follow the existing convention `JIRA-KEY - Step N`.
- Xray step `action` maps to the Test Step Description custom field (default 24).
- Xray step `result` maps to the Test Step Expected custom field (default 25).
- Xray step `data` maps to the Test Step Data custom field (default 26).

The script is idempotent: existing child steps are updated in place and missing steps are created. Manual and step-based tests are migrated; Cucumber and Generic tests are skipped. Use `--verify` to check existing steps without changing anything, `--dry-run` to preview, and `--prune` to delete extra child steps that no longer exist in Xray.

Run it after the issue migration and before or after relationship migration; it does not create relationships, only parent-child links.

### XRay Test Executions and Test Plans

`migrate-test-executions.js` links the migrated test management work packages using the Xray Cloud GraphQL API:

- `Test Plan` is the parent of its `Test Execution` when the execution belongs to exactly one plan.
- `Test Execution` is linked to each associated `Test` through an OpenProject relation (default type `includes`), not a parent-child relationship.
- `Test` remains the parent of its `Test Step` work packages.
- A Test can belong to multiple Test Executions; each execution gets its own relation, so no Test or Test Step data is duplicated.
- If an execution belongs to multiple plans, the execution's existing parent is not overwritten. The plans are linked to the execution by relation instead.
- Test step custom fields stay on the `Test Step` type.

The script is idempotent and only creates missing links. Use `--verify` to compare OpenProject with Xray, `--dry-run` to preview, and `--prune` to remove stale Test Execution → Test relations of the configured relation type. It does not delete work packages.

```bash
# Verify links without changing anything
node migrate-test-executions.js OPENPROJECT_ID --jira-project JIRA_PROJECT_KEY --verify

# Preview the link migration
node migrate-test-executions.js OPENPROJECT_ID --jira-project JIRA_PROJECT_KEY --dry-run

# Create missing plan parents and execution/test relations
node migrate-test-executions.js OPENPROJECT_ID --jira-project JIRA_PROJECT_KEY

# Limit the run to specific Test Execution keys
node migrate-test-executions.js OPENPROJECT_ID --jira-project JIRA_PROJECT_KEY --issues PROJ-123,PROJ-124
```

### Missing Jira Cases Report

`missing-report.js` compares all Jira issues in a project with the Jira keys stored in the OpenProject work packages. It writes every Jira case that cannot be found in OpenProject to `missing.txt`, one issue key per line (sorted naturally). If no cases are missing, the file is created empty.

`migrate.js` runs this check automatically at the end of every migration. The check is read-only and does not modify OpenProject.

```bash
node missing-report.js JIRA_PROJECT_KEY OPENPROJECT_ID
node missing-report.js JIRA_PROJECT_KEY OPENPROJECT_ID custom-missing.txt
```

```bash
# Remove duplicate work packages
node remove-duplicates.js OPENPROJECT_ID

# Delete all relationships
node delete-relationships.js OPENPROJECT_ID
```

This will delete all relationships (including parent-child hierarchies) between work packages in the specified project. 
Useful for:
- Testing relationship migration
- Cleaning up before re-running relationship migration
- Removing problematic relationships

The script preserves all work packages and their data, only removing the relationships between them.

## Troubleshooting

If you encounter issues:

1. Check your API tokens and permissions
2. Verify the custom field ID is correct
3. Ensure users are properly mapped
4. Check the console output for detailed error messages

## Need Professional Help?

Don't want to handle the migration yourself? We offer a complete done-for-you service that includes:

- Managed OpenProject hosting
- Complete Jira migration
- 24/7 technical support
- Secure and reliable infrastructure

Visit [portfolio.elitecoders.co/openproject](https://portfolio.elitecoders.co/openproject) to learn more about our managed OpenProject migration service.

## About

This project was built by [EliteCoders](https://www.elitecoders.co), a software development company specializing in custom software solutions. If you need help with:

- Custom software development
- System integration
- Migration tools and services
- Technical consulting

Please reach out to us at hello@elitecoders.co or visit our website at [www.elitecoders.co](https://www.elitecoders.co).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

Please make sure to update tests as appropriate.

## License

[MIT](LICENSE) - see the [LICENSE](LICENSE) file for details. 