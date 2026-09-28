/**
 * `table[key]` for a key that comes from outside (an OSM tag value, a venue's web page): the table's
 * own entries only. A plain lookup also finds what every object inherits, so a tag value of
 * "constructor", "toString" or "__proto__" would return a function or Object.prototype instead of
 * nothing, and anyone can set an OSM tag.
 */
export function ownValue<V>(table: Readonly<Record<string, V>>, key: string | null | undefined): V | undefined {
  return key != null && Object.hasOwn(table, key) ? table[key] : undefined;
}
