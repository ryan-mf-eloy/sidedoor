// GraphQL schema and fixture helpers. They deliberately model only data: a
// fixture never evaluates user-provided JavaScript or invokes a resolver.
import { createHash } from 'node:crypto';
import {
  GraphQLError,
  buildSchema,
  execute as graphqlExecute,
  getOperationAST,
  getVariableValues,
  parse,
  stripIgnoredCharacters,
  validate,
  validateSchema,
} from 'graphql';
import { payloadMatches } from './realtime.js';

export class GraphqlConfigError extends Error {
  constructor(message, field = 'sdl', location = null) {
    super(message);
    this.name = 'GraphqlConfigError';
    this.field = field;
    this.line = location && location.line || null;
    this.column = location && location.column || null;
  }
}

export const DEFAULT_GRAPHQL_SDL = 'type Query { health: String }';

function graphqlError(message, code) {
  return new GraphQLError(message, { extensions: code ? { code } : undefined });
}

function errorResult(error, fallbackCode = 'SIDEDOOR_GRAPHQL_ERROR') {
  return {
    errors: [{
      message: error && error.message ? error.message : String(error),
      extensions: { code: error && error.extensions && error.extensions.code || fallbackCode },
    }],
  };
}

export function graphqlResultFromErrors(errors) {
  return { errors: (errors || []).map((error) => ({
    message: error.message || String(error),
    ...(error.locations ? { locations: error.locations } : {}),
    ...(error.path ? { path: error.path } : {}),
    extensions: { code: error.extensions && error.extensions.code || 'GRAPHQL_VALIDATION_FAILED' },
  })) };
}

function errorLocation(error) {
  const location = error && error.locations && error.locations[0];
  return location ? { line: location.line, column: location.column } : null;
}

// Keep SDL validation in the domain module so persistence and live editor
// feedback apply the same GraphQL rules instead of drifting apart.
export function validateGraphqlSdl(sdl) {
  const source = String(sdl == null ? '' : sdl).trim();
  if (!source) return { valid: false, message: 'GraphQL SDL is required', line: 1, column: 1 };
  let schema;
  try {
    schema = buildSchema(source);
  } catch (error) {
    const location = errorLocation(error);
    return { valid: false, message: error.message, line: location && location.line || 1, column: location && location.column || 1 };
  }
  const problems = validateSchema(schema);
  if (problems.length) {
    const location = errorLocation(problems[0]);
    return {
      valid: false,
      message: problems.map((problem) => problem.message).join('; '),
      line: location && location.line || 1,
      column: location && location.column || 1,
    };
  }
  return { valid: true, schema };
}

export function compileGraphqlSchema(sdl) {
  const result = validateGraphqlSdl(sdl);
  if (!result.valid) throw new GraphqlConfigError(result.message, 'sdl', result);
  return result.schema;
}

export function operationFingerprint(query) {
  try {
    return createHash('sha256').update(stripIgnoredCharacters(String(query || ''))).digest('hex');
  } catch {
    return '';
  }
}

export function analyzeGraphqlOperation({ sdl, query, variables = {}, operationName } = {}) {
  const schema = compileGraphqlSchema(sdl);
  if (!query || !String(query).trim()) return { schema, errors: [graphqlError('GraphQL query is required', 'GRAPHQL_PARSE_FAILED')] };
  if (variables != null && (typeof variables !== 'object' || Array.isArray(variables))) {
    return { schema, errors: [graphqlError('variables must be an object', 'BAD_USER_INPUT')] };
  }
  let document;
  try {
    document = parse(String(query));
  } catch (error) {
    return { schema, errors: [error] };
  }
  const errors = validate(schema, document);
  if (errors.length) return { schema, document, errors };
  const operation = getOperationAST(document, operationName || undefined);
  if (!operation) {
    return { schema, document, errors: [graphqlError('Unable to identify the requested GraphQL operation', 'OPERATION_RESOLUTION_FAILURE')] };
  }
  const variableValues = getVariableValues(schema, operation.variableDefinitions || [], variables || {});
  if (variableValues.errors) return { schema, document, operation, errors: variableValues.errors };
  return {
    schema,
    document,
    operation,
    operationType: operation.operation,
    operationName: operation.name ? operation.name.value : '',
    documentHash: operationFingerprint(query),
    // Fixtures may intentionally discriminate on request metadata that is not
    // referenced by the operation itself. Preserve those values while using
    // GraphQL's coerced values for every declared variable.
    variables: { ...(variables || {}), ...(variableValues.coerced || {}) },
    errors: [],
  };
}

function identityMatches(fixture, operation) {
  if (fixture.operationName && fixture.operationName !== operation.operationName) return false;
  if (fixture.documentHash && fixture.documentHash !== operation.documentHash) return false;
  return true;
}

// Matching remains deterministic when users create multiple fixtures. The
// order in SQLite is the final tiebreaker after operation identity and a more
// specific variable matcher, matching the UI's explicit priority model.
export function selectGraphqlFixture(fixtures, operation) {
  const candidates = (fixtures || []).filter((fixture) => fixture.enabled
    && fixture.operationType === operation.operationType && identityMatches(fixture, operation));
  const specific = candidates.find((fixture) => fixture.variablesMatch != null && payloadMatches(fixture.variablesMatch, operation.variables));
  if (specific) return specific;
  return candidates.find((fixture) => fixture.variablesMatch == null) || null;
}

export function isIntrospectionOperation(operation) {
  return !!operation && operation.document.definitions.some((definition) => definition.selectionSet
    && definition.selectionSet.selections.some((selection) => selection.name && (selection.name.value === '__schema' || selection.name.value === '__type')));
}

export function fixtureNotFoundResult() {
  return errorResult(graphqlError('No fixture matches this GraphQL operation', 'SIDEDOOR_FIXTURE_NOT_FOUND'));
}

export function inspectorOnlyResult() {
  return errorResult(graphqlError('This GraphQL inspector captures the operation but has no mock fixture', 'SIDEDOOR_INSPECTOR_ONLY'));
}

export function invalidOperationResult(errors) {
  return graphqlResultFromErrors(errors);
}

export async function executeIntrospection(operation) {
  return graphqlExecute({
    schema: operation.schema,
    document: operation.document,
    operationName: operation.operationName || undefined,
    variableValues: operation.variables,
  });
}

export function sleep(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  return duration ? new Promise((resolve) => setTimeout(resolve, duration)) : Promise.resolve();
}

export async function* fixtureEventStream(fixture) {
  const events = fixture.subscriptionEvents && fixture.subscriptionEvents.length
    ? fixture.subscriptionEvents
    : [{ delayMs: fixture.delayMs || 0, payload: fixture.response }];
  for (const event of events) {
    await sleep(event.delayMs);
    yield event.payload;
  }
}
