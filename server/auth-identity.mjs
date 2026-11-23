export function normalizeIdentity(value) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const text = value.trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return text;
  if (!/^\+?[0-9 ()-]+$/.test(text)) return null;
  let phone = text.replace(/[ ()-]/g, '');
  if (phone.startsWith('08')) phone = '+62' + phone.slice(1);
  else if (phone.startsWith('628')) phone = '+' + phone;
  return /^\+[1-9][0-9]{8,14}$/.test(phone) ? phone : null;
}
