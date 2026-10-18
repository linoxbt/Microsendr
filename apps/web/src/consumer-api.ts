export async function consumerRequest<T = any>(
  path: string,
  method = 'GET',
  body?: object,
  csrf?: string,
): Promise<T> {
  const response = await fetch(`/personal/api/${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-kora-csrf': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(data?.error?.message ?? 'We could not connect. Please try again.');
  return data;
}
export type ConsumerProfile = {
  email: string | null;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  first_name: string;
  last_name: string;
  username: string;
  phone: string;
  residence_country: string;
  nationality: string | null;
  date_of_birth: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  occupation: string;
  display_currency: string;
  profile_version: number;
  identity_status: string;
  identity_locked: boolean;
  has_password: boolean;
};
export const profileKeys = [
  'first_name',
  'last_name',
  'username',
  'phone',
  'residence_country',
  'nationality',
  'date_of_birth',
  'address_line1',
  'address_line2',
  'city',
  'region',
  'postal_code',
  'occupation',
  'display_currency',
] as const;
export const emptyProfile = {
  first_name: '',
  last_name: '',
  username: '',
  phone: '',
  residence_country: 'NG',
  nationality: null,
  date_of_birth: '',
  address_line1: '',
  address_line2: '',
  city: '',
  region: '',
  postal_code: '',
  occupation: '',
  display_currency: 'USD',
};
export const countries = [
  ['NG', 'Nigeria'],
  ['GH', 'Ghana'],
  ['KE', 'Kenya'],
  ['ZA', 'South Africa'],
  ['GB', 'United Kingdom'],
  ['US', 'United States'],
  ['CA', 'Canada'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['AE', 'United Arab Emirates'],
] as const;
export function profilePayload(value: any) {
  return Object.fromEntries(
    profileKeys.map((key) => [key, value[key] ?? (key === 'nationality' ? null : '')]),
  );
}
