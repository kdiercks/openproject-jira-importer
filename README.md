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

#### OpenProject Configuration
- `OPENPROJECT_HOST`: Your OpenProject instance URL
- `OPENPROJECT_API_KEY`: Your OpenProject API key (generate in Settings > My account > Access token)

#### Custom Field Configuration
- `JIRA_ID_CUSTOM_FIELD`: The ID of the custom field in OpenProject that stores the Jira issue ID
  - This must be a text custom field
  - Find the ID in OpenProject: Administration > Custom fields > Work packages
  - This variable is required — the migration will fail with a clear error if not set

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