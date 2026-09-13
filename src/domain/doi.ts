const DOI_PREFIX_RE = /^doi:\s*/i;
const DOI_URL_RE = /^https?:\/\/(?:dx\.)?doi\.org\//i;

export function normalizeDoi(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let value = raw.trim();
  if (value === "") return null;
  value = value.replace(DOI_URL_RE, "");
  value = value.replace(DOI_PREFIX_RE, "");
  value = value.trim().toLowerCase();
  return value === "" ? null : value;
}

export function displayDoi(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.trim();
  return value === "" ? null : value;
}

export function doisMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeDoi(a);
  const nb = normalizeDoi(b);
  return na !== null && nb !== null && na === nb;
}
