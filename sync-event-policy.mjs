import { timestampMs } from './timestamp-utils.mjs';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function matchesStoredSyncEvent(stored, event) {
  let storedPayload = stored?.payload;
  if (typeof storedPayload === 'string') {
    try { storedPayload = JSON.parse(storedPayload); } catch { return false; }
  }
  const outletId = event?.outletId || null;
  const occurredAtMatches = event?.at == null || timestampMs(stored?.occurred_at) === timestampMs(event.at);
  return stored?.event_type === event?.type
    && stored?.outlet_id === outletId
    && occurredAtMatches
    && canonicalJson(storedPayload) === canonicalJson(event?.payload);
}

