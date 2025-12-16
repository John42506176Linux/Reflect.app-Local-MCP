import { t as tryImport } from './index-CLFto6T2.js';

const getToJsonSchemaFn = async () => {
  const { JSONSchema } = await tryImport(import('effect'), "effect");
  return (schema) => JSONSchema.make(schema);
};

export { getToJsonSchemaFn };
