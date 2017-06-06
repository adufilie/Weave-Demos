/**
 * Queries a JSON RPC 2.0 service. This function requires jQuery for the jQuery.post() functionality.
 * @param {string} url The URL of the service.
 * @param {string} method Name of the method to call on the server.
 * @param {?Array|Object} params Parameters for the server method.
 * @param {Function} resultHandler Optional Function to call when the RPC call returns.  This function will be passed the result of the method as the first parameter.
 * @param {string|number=} queryId Optional id to be associated with this RPC call.  This will be passed as the second parameter to the resultHandler function.
 * @return A Promise.
 */
function queryService(url, method, params, resultHandler, queryId)
{
	var request = {
		jsonrpc: "2.0",
		id: queryId || "no_id",
		method: method,
		params: params
	};
	jQuery.post(url, JSON.stringify(request), _handleResponse, "json");
	
	var promise, resolve, reject;
	if (window.Promise)
	{
		promise = new Promise(function(_resolve, _reject) {
			resolve = _resolve;
			reject = _reject;
		});
	}
	
	function _handleResponse(response)
	{
		if (response.error)
		{
			if (promise)
				reject(response.error);
			else
				console.error(JSON.stringify(response, null, 3));
		}
		else
		{
			if (resultHandler)
				resultHandler(response.result, queryId);
			if (promise)
				resolve(response.result);
		}
	}
	
	return promise;
}

/**
 * Makes a batch request to a JSON RPC 2.0 service. This function requires jQuery for the jQuery.post() functionality.
 * @param {string} url The URL of the service.
 * @param {string} method Name of the method to call on the server for each entry in the queryIdToParams mapping.
 * @param {Array|Object} queryIdToParams A mapping from queryId to RPC parameters.
 * @param {function(Array|Object)} resultsHandler Optional Function to receive a mapping from queryId to RPC result.
 * @return A Promise.
 */
function bulkQueryService(url, method, queryIdToParams, resultsHandler)
{
	var batch = [];
	for (var queryId in queryIdToParams)
		batch.push({jsonrpc: "2.0", id: queryId, method: method, params: queryIdToParams[queryId]});
	if (batch.length)
		jQuery.post(url, JSON.stringify(batch), handleBatch, "json");
	else
		setTimeout(handleBatch, 0);

	var promise, resolve, reject;
	if (window.Promise)
	{
		promise = new Promise(function(_resolve, _reject) {
			resolve = _resolve;
			reject = _reject;
		});
	}
	
	function handleBatch(batchResponse)
	{
		var results = Array.isArray(queryIdToParams) ? [] : {};
		for (var i in batchResponse)
		{
			var response = batchResponse[i];
			if (response.error)
			{
				if (promise)
					resolve(response.error);
				else
					console.error(JSON.stringify(response, null, 3));
			}
			else
			{
				results[response.id] = response.result;
			}
		}
		if (resultsHandler)
			resultsHandler(results);
		if (promise)
			resolve(results);
	}
	
	return promise;
}

/**
 * Queries a Weave data server, assumed to be at the root folder at the current host.
 * Available methods are listed here: http://ivpr.github.io/Weave-Binaries/javadoc/weave/servlets/DataService.html
 * This function requires jQuery for the jQuery.post() functionality.
 * @param {string} method Name of the method to call on the server.
 * @param {?Array|Object} params Parameters for the server method.
 * @param {Function} resultHandler Function to call when the RPC call returns.  This function will be passed the result of the method as the first parameter.
 * @param {string|number=} queryId Optional id to be associated with this RPC call.  This will be passed as the second parameter to the resultHandler function.
 */
function queryDataService(method, params, resultHandler, queryId)
{
	return queryService('/WeaveServices/DataService', method, params, resultHandler, queryId);
}

/**
 * Gets a complete tree of Entity objects.
 * @param {string} dataServiceUrl The URL to the Weave data service, such as "/WeaveServices/DataService".
 * @param {number} rootEntityId The ID of a Weave entity.
 * @param {function(Object)} callback A function which will receive the root Entity object with a 'children' property
 *                 which will be an Array of child Entity objects, also having 'children' properties, and so on.
 */
function getEntityTree(dataServiceUrl, rootEntityId, callback)
{
	var lookup = {};
	function cacheEntityTree(ids) {
		queryService(dataServiceUrl, 'getEntities', [ids], function(entities) {
			// compile a list of all child ids
			var allChildIds = [];
			entities.forEach(function(entity) {
				lookup[entity.id] = entity;
				allChildIds = allChildIds.concat(entity.childIds);
			});
			// filter out cached ids
			allChildIds = allChildIds.filter(function(id) { return !lookup[id]; });
			// recursive call if we are still missing some entities
			if (allChildIds.length)
				return cacheEntityTree(allChildIds);
			// all done, so fill in 'children' property of all entities and return the root entity
			for (var id in lookup)
				lookup[id].children = lookup[id].childIds.map(function(id){ return lookup[id]; });
			callback(lookup[rootEntityId]);
		});
	}
	cacheEntityTree([rootEntityId]);
}

/**
 * This will find a column using its title and its parent table's title as search criteria.
 * Note that title metadata can be changed by the admin, and there is nothing preventing multiple columns or tables from having identical titles.
 * If there are multiple data tables with the same title, only the last matching table will be checked.
 * @param {string} dataTableTitle The value of the "title" metadata for a data table.
 * @param {string} columnTitle The value of the "title" metadata for a column which is a child of that data table.
 * @param {function(Object)} resultHandler A callback function which will be called on success. The function will receive a single entity object for a matching column.
 */
function getMatchingColumnEntity(dataTableTitle, columnTitle, resultHandler)
{
	queryDataService("findEntityIds", [{"title": dataTableTitle}, []], function(tableIds) {
		if (tableIds.length == 0)
			return fail();
		queryDataService("getEntities", [tableIds.pop()], function(tables) {
			queryDataService("getEntities", [tables[0].childIds], function(entities) {
				entities = entities.filter(function (entity) { return entity.publicMetadata['title'] == columnTitle; });
				if (entities.length == 0)
					return fail();
				resultHandler(entities.pop());
			});
		});
	});
	function fail() { console.error("No matching column found (" + [dataTableTitle, columnTitle] + ")"); }
}

/**
 * This function modifies a session state object generated by Weave by inserting a value at a specified path.
 * @param {Object} stateToModify The session state object to modify.
 * @param {Array.<String>} path A series of object names in the Weave session state hierarchy.
 * @param {Object} value The replacement session state to insert at the given path.
 * @return {boolean} true on success, false on failure
 */
function modifySessionState(stateToModify, path, value)
{
	if (path.length == 0)
		return false;
	var property = path[0];
	path = path.slice(1);
	if (Array.isArray(stateToModify))
	{
		for (var i in stateToModify)
		{
			var dynamicState = stateToModify[i];
			if (property == dynamicState.objectName)
			{
				if (path.length)
					return modifySessionState(dynamicState.sessionState, path, value);
				dynamicState.sessionState = value;
				return true;
			}
		}
		return false;
	}
	if (path.length)
		return modifySessionState(stateToModify[property], path, value);
	stateToModify[property] = value;
	return true;
}

/**
 * This function can be used for bulk loading of SQL tables without going through the Admin Console.
 * It's not recommended to be used on a public website.
 * @param {string} connectionName Weave Admin connection name
 * @param {string} password Weave Admin password
 * @param {string} sqlSchema Schema name
 * @param {string} sqlTable Table name
 * @param {string} keyColumn Name of column in sql table that uniquely identifies rows in the table.
 * @param {function(number)} resultHandler a function which receives the tableId
 */
function weaveAdminImportSQL(connectionName, password, sqlSchema, sqlTable, keyColumn, resultHandler)
{
	var url = '/WeaveServices/AdminService';
	var tableTitle = sqlTable; // the name which will be visible to end-users
	var keyType = sqlTable;
	var secondaryKeyColumn = null; // used for dimension slider format
	var filterColumnNames = []; // used for generating filtered column queries
	var append = true; // set to false to force creation of a new Weave table entity even if a matching one already exists
	
	if (resultHandler == null)
		resultHandler = function(result) { console.log("Successfully imported table " + sqlTable + "; Weave table ID = " + result); };
	
	var method = "importSQL";
	var params = {
		connectionName: connectionName,
		password: password,
		schemaName: sqlSchema,
		tableName: sqlTable,
		keyColumnName: keyColumn,
		secondaryKeyColumnName: secondaryKeyColumn,
		configDataTableName: tableTitle, 
		keyType: keyType,
		filterColumnNames: filterColumnNames,
		append: append
	};
	
	queryService(url, method, params, resultHandler);
}

/**
 * Updates the metadata for columns of a specified table.
 * It's not recommended to use this function on a public website.
 * See documentation for DataEntityWithRelationships (referred to here as an "entity object")
 * http://ivpr.github.io/Weave-Binaries/javadoc/weave/config/DataConfig.DataEntityWithRelationships.html
 * @param {string} user AdminConsole connection name.
 * @param {string} pass AdminConsole password.
 * @param {number} tableId The ID of the table.
 * @param {function(Object):Object} entityUpdater A function that alters an entity object's metadata.
 *     Example: function(entity) { entity.privateMetadata.sqlQuery += " where myfield = 'myvalue'"; }
 */
function weaveAdminUpdateColumns(user, pass, tableId, entityUpdater) {
	var url = '/WeaveServices/AdminService';
	var getEntities = queryService.bind(null, url, 'getEntities');
	var bulkUpdateEntities = bulkQueryService.bind(null, url, 'updateEntity');
	getEntities([user, pass, [tableId]], function(tables) {
		getEntities([user, pass, tables[0].childIds], function(columns) {
			bulkUpdateEntities(
				columns.map(function(e){ entityUpdater(e); return [user, pass, e.id, e]; })
			)
		});
	});
}


////////////////////////////////////////////////////////////////


/**
 * @deprecated Consider using weave.path([...]).setColumn(metadata[, dataSourceName]) instead.
 * @example weave.path('defaultColorDataColumn').setColumn({weaveEntityId: 123, sqlParams: [1,2,3]})
 *
 * 
 * This will create or update a DynamicColumn to refer to an attribute column on a Weave data server.
 * @param {Weave} weave A Weave instance.
 * @param {Array|WeavePath} path The path to an existing DynamicColumn object, or the path specifying the location to create one inside a LinkableHashMap.
 * @param {number} columnId The id of an attribute column on a Weave server (visible through the Admin Console and in its configuration tables)
 *                          or a set of metadata used to uniquely identify the column.  If a metadata object is used, the idFields property of
 *                          the WeaveDataSource must be set accordingly to specify which fields will be used to uniquely identify columns.
 * @param {string=} dataSourceName The name of an existing WeaveDataSource object in the Weave session state.
 * @param {Array=} sqlParams optional set of parameters to use that correspond to the '?' placeholders in the SQL query on the server.
 */
function setWeaveColumnId(weave, path, columnId, dataSourceName, sqlParams)
{
	// convert an Array to a WeavePath object
	if (Array.isArray(path))
		path = weave.path(path);
	
	if (!dataSourceName)
		dataSourceName = weave.evaluateExpression([], 'this.getNames(WeaveDataSource)[0]');
	
	var metadata = {"sqlParams": sqlParams};
	if (typeof columnId == 'object')
		for (var k in columnId)
			metadata[k] = columnId[k];
	else
		metadata['weaveEntityId'] = columnId;
	
	path.setColumn(metadata, dataSourceName);
}

/**
 * @deprecated Replacement code: weave.path(toolName).pushLayerSettings(layerName).state('visible', enable)
 * 
 * This will show or hide a layer on a visualization.
 * @param {Object} weave Weave instance
 * @param {string} toolName String
 * @param {string} layerName String
 * @param {boolean} enable true to show, false to hide
 */
function enableWeaveVisLayer(weave, toolName, layerName, enable)
{
	weave.path(toolName).pushLayerSettings(layerName).state('visible', enable);
}

/**
 * Deterministic JSON encoding
 * @param value The value to stringify
 * @param replacer A replacer function that you would give to JSON.stringify()
 * @param indent An indent value that you would give to JSON.stringify()
 * @param json_values_only Set this to true to change NaN and undefined values to null
 * @returns A JSON string
 */
function weaveStringify(value, replacer, indent, json_values_only)
{
	if (typeof indent == 'number')
	{
		var str = ' ';
		while (str.length < indent)
			str += str;
		indent = str.substr(0, indent);
	}
	if (!indent)
		indent = '';
	return _weaveStringify("", value, replacer, indent ? '\n' : '', indent, json_values_only);
}
function _weaveStringify(key, value, replacer, lineBreak, indent, json_values_only)
{
	if (replacer != null)
		value = replacer(key, value);
	
	var output;
	var item;
	var key;
	
	if (typeof value == 'string')
		return _weaveEncodeString(value);
	
	// non-string primitives
	if (value == null || typeof value != 'object')
	{
		if (json_values_only && (value === undefined || !isFinite(value)))
			value = null;
		if (value == null)
			return 'null';
		return value + '';
	}
	
	// loop over keys in Array or Object
	var lineBreakIndent = lineBreak + indent;
	var valueIsArray = Array.isArray(value);
	output = [];
	if (valueIsArray)
	{
		for (var i = 0; i < value.length; i++)
			output.push(_weaveStringify(String(i), value[i], replacer, lineBreakIndent, indent, json_values_only));
	}
	else
	{
		for (key in value)
			output.push(_weaveEncodeString(key) + ": " + _weaveStringify(key, value[key], replacer, lineBreakIndent, indent, json_values_only));
		// sort keys
		output.sort();
	}
	
	if (output.length == 0)
		return valueIsArray ? "[]" : "{}";
	
	return (valueIsArray ? "[" : "{")
		+ lineBreakIndent
		+ output.join(indent ? ',' + lineBreakIndent : ', ')
		+ lineBreak
		+ (valueIsArray ? "]" : "}");
}
var WEAVE_ENCODE_LOOKUP = {'\b':'b', '\f':'f', '\n':'n', '\r':'r', '\t':'t', '\\':'\\'};
function _weaveEncodeString(string, quote)
{
	if (!quote)
		quote = '"';
	if (string == null)
		return 'null';
	var result = new Array(string.length);
	for (var i = 0; i < string.length; i++)
	{
		var chr = string.charAt(i);
		var esc = chr == quote ? quote : WEAVE_ENCODE_LOOKUP[chr];
		result[i] = esc ? '\\' + esc : chr;
	}
	return quote + result.join('') + quote;
}