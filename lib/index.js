/**
 * @module
 * @author Özüm Eldoğan
 */
/*jslint node: true, nomen: true, regexp: true */
/*global __dirname */
"use strict";

process.env.SUPPRESS_NO_CONFIG_WARNING = true;

var fs              = require('fs-extra');
var path            = require('path');
var pgStructure     = require('pg-structure');
var cons            = require('consolidate');
var async           = require('async');
var beautify        = require('js-beautify').js_beautify;
var inflection      = require('inflection');
var config          = require('config');
var lodash          = require('lodash');
require('./_polyfill-quote.js');       // add String's prototype quote function.


/**
 * @private
 * @typedef {Object} template
 * @property {string} engine - Template engine to use.
 * @property {string} extension - File extension to use in template files.
 * @property {string} folder - Template folder to look for templates.
 */


/**
 * Gets requested config by prefixing the key with 'sequelize-pg-generator.'
 * As a result getConfig('database.host') returns result of config.get('sequelize-pg-generator.database.host')
 * @private
 * @param configKey
 * @returns {Object|any}
 */
function getConfig(configKey) {
    configKey = 'sequelize-pg-generator.' + configKey;
    return config.get(configKey);
}


/**
 * Gets requested config value. Returns more specific config for table if there is one, returns general otherwise.
 * Specific configs are config keys having suffix "Override".
 * @private
 * @param {string} table - Name of the table. This will be used to find specific config for the table.
 * @param {string} configName - Configuration name to look for.
 * @returns {*}
 * @example
 * var config = {
 *     "generate": {
 *         "columnDescription": false
 *     },
 *     "generateOverride: {
 *         "account": {
 *             "columnDescription": true
 *         }
 *     }
 * };
 *
 * console.log(getSpecificConfig('contact.columnDescription'));  // false
 * console.log(getSpecificConfig('account.columnDescription'));  // true
 */
function getSpecificConfig(table, configName) {
    var specific  = configName.replace(/^(.+?)\./, '$1Override.' + table + '.'); // generateOverride.product_category.columnDefault
    return config.has(specific) ? getConfig(specific) : getConfig(configName);
}


/**
 * Renders the template and executes callback function.
 * @private
 * @param {string} filePath - Path of the template file relative to template folder.
 * @param {object} locals - Local variables to pass to template
 * @param {function} fn - Callback function(err, output)
 */
function template(filePath, locals, fn) {
    filePath = path.join(getConfig('template.folder'), filePath  + '.' + getConfig('template.extension')); // i.e. index -> index.ejs
    return cons[getConfig('template.engine')].call(null, filePath, locals, fn);                            // i.e. cons.swig('views/page.html', { user: 'tobi' }, function(err, html){}
}


/**
 * Parses by reverse engineering using pgStructure module and calls callback.
 * @private
 * @param {function} callback - Callback function(err, structure)
 */
function parseDB(callback) {
    pgStructure(getConfig('database.host'), getConfig('database.database'), getConfig('database.user'),
        getConfig('database.password'), { port: getConfig('database.port'), schema: getConfig('database.schema') },
        callback);
}


/**
 * Given plain object, this function does the following:
 * - Strips null or undefined values from object,
 * - Add quotes around string values
 * @private
 * @param {object} obj - Simple object to filter.
 * @returns {object}
 */
function filterAttributes(obj) {
    var attribute;
    for (attribute in obj) {
        if (obj.hasOwnProperty(attribute)) {
            if (obj[attribute] === undefined || obj[attribute] === null) {
                delete obj[attribute];
            } else if (lodash.isString(obj[attribute])) {
                obj[attribute] = obj[attribute].quote();    // DO NOT quote type string. It is a JS variable.
            }
        }
    }
    return obj;
}


/**
 * Clears SQL type escapes (Two quote '' to one quote ') and strips beginning and trailing quotes around string.
 * @private
 * @param {string} string - Default
 * @returns {string|undefined}
 * @example
 * var clear = clearDefaultValue("'No ''value'' given'");
 * console.log(clear);    // No value 'given'
 */
function clearDefaultValue(string) {
    // Does not support SQL functions. IMHO it is better to handle sql function default values in RDMS.
    if (string.charAt(0) === "'" || string.charAt(0) === '"') {
        string = string.substring(1, string.length - 1);
        string = string.replace(/''/g, "'");
    } else {
        return undefined;
    }
    return string;
}


/**
 * Calculates belongsTo relation name based on table, column and config.
 * @private
 * @param {object} fkc - pg-structure foreign key constraint object.
 * @returns {string} - Name for the belongsTo relationship.
 */
function getBelongsToName(fkc) {
    var as          = fkc.foreignKey(0).name(),                                             // company_id
        tableName   = fkc.table().name(),
        camelCase   = getSpecificConfig(tableName, 'generate.relationAccessorCamelCase'),
        prefix      = getSpecificConfig(tableName, 'generate.prefixForBelongsTo'),          // related
        separator   = camelCase ? '' : '_';

    if (as.match(/_id$/i)) {
        as = as.replace(/_id$/i, '');                                                       // company_id -> company
    } else {
        as = prefix + separator + as;                                                       // company -> related_company
    }
    if (camelCase) {
        as = inflection.camelize(as, true);
    }
    return inflection.singularize(as);
}


/**
 * Calculates belongsToMany relation name based on table, column and config.
 * @private
 * @param {object} hasManyThrough - pg-structure foreign key constraint object.
 * @returns {string} - Name for the belongsToMany relationship.
 */
function getBelongsToManyName(hasManyThrough) {
    return inflection.pluralize(getBelongsToName(hasManyThrough.throughForeignKeyConstraint()));
}


/**
 * Calculates hasMany relation name based on table, column and config.
 * @private
 * @param {object} hasMany - pg-structure foreign key constraint object.
 * @returns {string} - Name for the belongsTo relationship.
 */
function getHasManyName(hasMany) {
    var as, tableName;

    if (hasMany.through() !== undefined) {
        as = inflection.pluralize(getBelongsToName(hasMany.throughForeignKeyConstraint()));
    } else {
        as          = inflection.pluralize(hasMany.name());                  // cart_cart_line_items
        tableName   = hasMany.table().name();
        if (getSpecificConfig(tableName, 'generate.stripFirstTableFromHasMany')) {
            as = as.replace(new RegExp('^' + tableName + '[_-]?', 'i'), '');     // cart_cart_line_items -> cart_line_items
        }
        if (getSpecificConfig(tableName, 'generate.relationAccessorCamelCase')) {
            as = inflection.camelize(as, true);                                 // cart_line_items -> cartLineItems
        }
    }

    return as;
}


/**
 * Calculates model name for given table.
 * @private
 * @param {object} table - pg-structure table object.
 * @returns {string} - Model name for table
 */
function getModelNameFor(table) {
    var schemaName = getSpecificConfig(table.name(), 'generate.modelCamelCase') ? inflection.camelize(table.schema().name(), true) : table.schema().name(),
        tableName  = getSpecificConfig(table.name(), 'generate.modelCamelCase') ? inflection.camelize(table.name(), true) : table.name();

    return getSpecificConfig(table.name(), 'generate.useSchemaName') ? schemaName + '.' + tableName : tableName;
}


/**
 * Returns table details as plain object to use in templates.
 * @private
 * @param table
 * @returns {Object}
 */
function getTableOptions(table) {
    var specificName    = 'tableOptionsOverride.' + table.name(),
        specificOptions = config.has(specificName) ? getConfig(specificName) : {},
        generalOptions  = getConfig('tableOptions'),
        otherOptions    = {
            modelName       : getModelNameFor(table),
            tableName       : table.name(),
            schema          : table.schema().name(),
            comment         : getSpecificConfig(table.name(), 'generate.tableDescription') ? table.description() : undefined,
            columns         : [],
            hasManies       : [],
            belongsTos      : [],
            belongsToManies : []
        },
        tableOptions            = filterAttributes(lodash.defaults(specificOptions, generalOptions, otherOptions));
    tableOptions.baseFileName   = table.name();
    return tableOptions;

}


/**
 * Returns column details as plain object to use in templates.
 * @private
 * @param {object} column - pg-structure column object
 * @returns {Object} - Simple object to use in template
 */
function getColumnDetails(column) {
    var result = filterAttributes({
        source              : 'generator',
        accessorName        : getSpecificConfig(column.table().name(), 'generate.columnAccessorCamelCase') ? inflection.camelize(column.name(), true) : column.name(),
        name                : column.name(),
        primaryKey          : column.isPrimaryKey(),
        autoIncrement       : column.isAutoIncrement() && getSpecificConfig(column.table().name(), 'generate.columnAutoIncrement') ? true : undefined,
        allowNull           : column.allowNull(),
        defaultValue        : getSpecificConfig(column.table().name(), 'generate.columnDefault') && column.default() !== null ? clearDefaultValue(column.default()) : undefined,
        unique              : column.unique(),
        comment             : getSpecificConfig(column.table().name(), 'generate.columnDescription') ? column.description() : undefined,
        references          : column.foreignKeyConstraint() ? column.foreignKeyConstraint().referencesTable().name() : undefined,
        referencesKey       : column.foreignKeyConstraint() ? column.foreignKeyConstraint().foreignKey(0).name() : undefined,
        onUpdate            : column.onUpdate(),
        onDelete            : column.onDelete()
    });
    result.type = column.sequelizeType(getSpecificConfig(column.table().name(), 'generate.dataTypeVariable')); // To prevent type having quotes.
    return result;
}


/**
 * Returns hasMany details as plain object to use in templates.
 * @private
 * @param {object} hasMany - pg-structure hasMany object
 * @returns {Object} - Simple object to use in template
 */
function getHasManyDetails(hasMany) {
    return filterAttributes({
        type                : 'hasMany',
        source              : 'generator',
        name                : hasMany.name(),
        model               : getModelNameFor(hasMany.referencesTable()),
        as                  : getHasManyName(hasMany),
        targetSchema        : hasMany.referencesTable().schema().name(),
        targetTable         : hasMany.referencesTable().name(),
        foreignKey          : hasMany.foreignKey(0).name(), // Sequelize support single key only
        onDelete            : hasMany.onDelete(),
        onUpdate            : hasMany.onUpdate(),
        through             : hasMany.through() ? hasMany.through().name() : undefined
    });
}


/**
 * Returns belongsTo details as plain object to use in templates.
 * @private
 * @param {object} fkc - pg-structure belongsTo object
 * @returns {Object} - Simple object to use in template
 */
function getBelongsToDetails(fkc) {
    return filterAttributes({
        type                : 'belongsTo',
        source              : 'generator',
        name                : fkc.name(),
        model               : getModelNameFor(fkc.referencesTable()),
        as                  : getBelongsToName(fkc),
        targetSchema        : fkc.referencesTable().schema().name(),
        targetTable         : fkc.referencesTable().name(),
        foreignKey          : fkc.foreignKey(0).name(), // Sequelize support single key only
        onDelete            : fkc.onDelete(),
        onUpdate            : fkc.onUpdate()
    });
}

/**
 * Returns belongsToMany details as plain object to use in templates.
 * @private
 * @param {object} hasManyThrough - pg-structure hasManyThrough object
 * @returns {Object} - Simple object to use in template
 */
function getBelongsToManyDetails(hasManyThrough) {
    return filterAttributes({
        type                : 'belongsToMany',
        source              : 'generator',
        name                : hasManyThrough.name(),
        model               : getModelNameFor(hasManyThrough.referencesTable()),
        as                  : getBelongsToManyName(hasManyThrough),
        targetSchema        : hasManyThrough.referencesTable().schema().name(),
        targetTable         : hasManyThrough.referencesTable().name(),
        foreignKey          : hasManyThrough.foreignKey(0).name(),      // Sequelize support single key only
        otherKey            : hasManyThrough.throughForeignKeyConstraint().foreignKey(0).name(),        // Sequelize support single key only
        onDelete            : hasManyThrough.onDelete(),
        onUpdate            : hasManyThrough.onUpdate(),
        through             : hasManyThrough.through().name()
    });
}


/**
 * Calculates and returns file name based on schema and table.
 * @private
 * @param {object} table - pg-structure table object
 * @returns {string} - file name for the model
 */
function getFileName(table) {
    var fileName = table.name() + '.js';
    if (getSpecificConfig(table.name(), 'generate.useSchemaName')) {        // Prefix with schema name if config requested it.
        fileName =  table.schema().name() + '_' + fileName;
    }
    return fileName;
}


/**
 * Returns if table is in the list of tables to be skipped. Looks for schema.table and table name.
 * @private
 * @param {object} table - pg-structure object
 * @param {string} detail - Type of object to include it in explanation
 * @returns {boolean}
 */
function shouldSkip(table, detail) {
    var skipTable = getConfig('generate.skipTable');            // Do not auto generate files for those tables.
    if (skipTable.indexOf(table.name()) !== -1 || skipTable.indexOf(table.schema().name() + '.' + table.name()) !== -1) {
        if (getConfig('output.log')) {
            if (detail === 'table') {
                console.log('INFO: (Skipped ' + detail + ') File \'' + getFileName(table) + '\' is skipped for model \'' + getModelNameFor(table) + '\'');
            } else if (detail === 'relation') {
                console.log('INFO: (Skipped ' + detail + ') Relation is skipped for model \'' + getModelNameFor(table) + '\'');
            }

        }
        return true;
    }
    return false;
}


/**
 * Generates all model files.
 * @private
 * @param {object} db - pg-structure db object
 * @param {function} next - Callback to execute.
 */
function generateModelFiles(db, next) {
    var q, templateTable;

    q = async.queue(function (task, workerCallback) {
        var output = getConfig('output.beautify') ? beautify(task.content, { indent_size: getConfig('output.indent'), preserve_newlines: getConfig('output.preserveNewLines') }) : task.content;
        fs.writeFile(path.join(getConfig('output.folder'), 'definition-files', getFileName(task.table)), output, workerCallback);
        if (getConfig('output.log')) { console.log('INFO: (Created) File \'' + getFileName(task.table) + '\' is created for model \'' + getModelNameFor(task.table) + '\''); }
    }, 4);

    db.schemas(function (schema) {
        schema.tables(function (table) {

            if (shouldSkip(table, 'table')) { return; }
            templateTable           = getTableOptions(table);
            table.columns(function (column) {
                templateTable.columns.push(getColumnDetails(column));
            });
            table.hasManies(function (hasMany) {
                if (shouldSkip(hasMany.referencesTable(), 'relation')) { return; }
                templateTable.hasManies.push(getHasManyDetails(hasMany));
            });
            table.hasManyThroughs(function (hasManyThrough) {
                if (shouldSkip(hasManyThrough.referencesTable(), 'relation') || shouldSkip(hasManyThrough.through(), 'relation')) { return; }
                if (getSpecificConfig(table.name(), 'generate.hasManyThrough')) {
                    templateTable.hasManies.push(getHasManyDetails(hasManyThrough)); // has many throughs are deprecated after Sequelize 2.0 RC3
                }
                if (getSpecificConfig(table.name(), 'generate.belongsToMany')) {
                    templateTable.belongsToManies.push(getBelongsToManyDetails(hasManyThrough));
                }
            });
            table.foreignKeyConstraints(function (fkc) {
                if (shouldSkip(fkc.referencesTable(), 'relation')) { return; }
                templateTable.belongsTos.push(getBelongsToDetails(fkc));
            });
            templateTable.relations = templateTable.hasManies.concat(templateTable.belongsTos, templateTable.belongsToManies);

            template('index', {
                table: templateTable,
                mainScript: path.join(getConfig('output.folder'), 'index.js'),
                warning: getConfig('output.warning')
            }, function (err, result) {
                if (err) { next(err); }
                q.push({content: result, table: table}, function (err) { if (err) { next(err); } });
            });
        });
    });

    q.drain = function () {
        next(null);
    };
}


/**
 * Creates 'definition-files' and 'definition-files-custom' directories if they do not exist.
 * Before creating definition-files it deletes definition-files directory.
 * @private
 * @param {function} next - Callback to execute
 */
function createOutputFolder(next) {
    var defPath         = path.join(getConfig('output.folder'), 'definition-files'),
        defPathCustom   = path.join(getConfig('output.folder'), 'definition-files-custom');

    fs.remove(defPath, function (err) {
        if (err) { next(err); }
        fs.createFile(path.join(defPath, '_Dont_add_or_edit_any_files'), function (err) {
            if (err) { next(err); }
            fs.mkdirs(defPathCustom, function (err) {
                if (err) { next(err); }
                next(null);
            });
        });
    });
}


/**
 * Generates index file by copying index.js from template directory to model directory. These locations come from
 * config.
 * @private
 * @param next
 */
function generateUtilityFiles(next) {
    fs.copy(path.join(getConfig('template.folder'), 'index.js'), path.join(getConfig('output.folder'), 'index.js'), function (err) {
        if (err) { next(err); }
        if (getConfig('output.log')) { console.log('INFO: Index file created: ' + path.resolve(path.join(getConfig('output.folder'), 'index.js'))); }
        fs.copy(path.join(getConfig('template.folder'), 'utils.js'), path.join(getConfig('output.folder'), 'utils.js'), function (err) {
            if (err) { next(err); }
            next(null);
        });
    });
}


/**
 * Combines default configuration, custom config file and command line options by overriding lower priority ones.
 * @private
 * @param {object} options - Options from command line.
 */
function setupConfig(options) {
    var customConfigFile, customConfig,
        defaultConfig       = require('../config/default.js');

    options = options || {};

    if (options.config) {
        customConfigFile    = options.config.charAt(0) === '/' || options.config.charAt(0) === '\\' ? options.config : path.join(process.cwd(), options.config); // Absolute or relative
        customConfig        = require(customConfigFile);
    }

    delete options.config;

    // Combine configs and override lower priority configs.
    config.util.extendDeep(config, defaultConfig, customConfig || {}, { "sequelize-pg-generator": options });
}


/**
 * Generates model files for Sequelize ORM.
 * @param {function} callback - Function to execute after completion of auto generation. callback(err)
 * @param {object} options - Options to override configuration parameters from config file
 * @param {string} options.host - IP address or host name of the database server
 * @param {number} options.port - Port of database server to connect
 * @param {string} options.database - Database name
 * @param {string} options.user - Username to connect to database
 * @param {string} options.password - Password to connect to database
 * @param {Array} options.schema - List of comma separated names of the database schemas to traverse. Example public,extra_schema.
 * @param {string} options.output - Output folder
 * @param {string} options.config - Path of the configuration file
 */
module.exports = function (callback, options) {
    setupConfig(options);
    if (getConfig('database.database') === undefined || getConfig('database.host') === undefined) {
        callback(new Error('Host and database are required.'));
    }

    async.waterfall([
        createOutputFolder,
        generateUtilityFiles,
        parseDB,
        generateModelFiles
    ], function (err) {
        if (err) { callback(err); }
        callback(null);
    });
};