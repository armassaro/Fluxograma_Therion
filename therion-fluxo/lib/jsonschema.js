'use strict';
/**
 * Validador mínimo de JSON Schema (subconjunto usado por fluxos/schema.json), sem dependências:
 * type, enum, required, properties, additionalProperties (bool|schema), propertyNames, minProperties,
 * items, minItems, anyOf, pattern, minLength, minimum.
 * @returns {string[]} erros no formato "<caminho>: <problema>"
 */
const TIPOS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: Number.isInteger,
  boolean: (v) => typeof v === 'boolean',
};

function validarSchema(schema, v, caminho = '$') {
  const erros = [];
  const e = (m) => erros.push(`${caminho}: ${m}`);
  if (schema.anyOf) {
    if (!schema.anyOf.some((s) => validarSchema(s, v, caminho).length === 0)) e('não corresponde a nenhuma forma aceita');
    return erros;
  }
  if (schema.type && !TIPOS[schema.type](v)) { e(`deveria ser ${schema.type}`); return erros; }
  if (schema.enum && !schema.enum.includes(v)) e(`valor "${v}" fora de [${schema.enum.join(', ')}]`);
  if (typeof v === 'string') {
    if (schema.minLength !== undefined && v.length < schema.minLength) e('texto vazio');
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) e(`"${v}" não segue o padrão ${schema.pattern}`);
  }
  if (typeof v === 'number' && schema.minimum !== undefined && v < schema.minimum) e(`mínimo ${schema.minimum}`);
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) e(`mínimo de ${schema.minItems} item(ns)`);
    if (schema.items) v.forEach((x, i) => erros.push(...validarSchema(schema.items, x, `${caminho}[${i}]`)));
  }
  if (TIPOS.object(v)) {
    const chaves = Object.keys(v);
    for (const r of schema.required || []) if (!(r in v)) e(`falta "${r}"`);
    if (schema.minProperties !== undefined && chaves.length < schema.minProperties) e('vazio');
    for (const k of chaves) {
      if (schema.propertyNames) erros.push(...validarSchema({ type: 'string', ...schema.propertyNames }, k, `${caminho}.${k} (nome)`));
      if (schema.properties && k in schema.properties) erros.push(...validarSchema(schema.properties[k], v[k], `${caminho}.${k}`));
      else if (schema.additionalProperties === false) e(`propriedade desconhecida "${k}"`);
      else if (TIPOS.object(schema.additionalProperties)) erros.push(...validarSchema(schema.additionalProperties, v[k], `${caminho}.${k}`));
    }
  }
  return erros;
}

module.exports = { validarSchema };
