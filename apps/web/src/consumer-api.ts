/** An API failure with the server's error code and HTTP status. */
export class ConsumerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'ConsumerRequestError';
  }
}
/** The Personal session is missing, expired or no longer matches its CSRF token. */
export class SessionExpiredError extends ConsumerRequestError {
  constructor(status: number, code: string | null) {
    super('Your session has ended. Sign in again to continue.', status, code);
    this.name = 'SessionExpiredError';
  }
}
export const sessionExpiredEvent = 'microsendr:personal-session-expired';
// Credential errors from sign-in routes (invalid_code, invalid_credentials) are not session expiry.
const expiredCodes = new Set(['personal_login_required', 'csrf_invalid']);
export function isSessionExpired(error: unknown): error is SessionExpiredError {
  return error instanceof SessionExpiredError;
}

export async function consumerRequest<T = any>(
  path: string,
  method = 'GET',
  body?: object,
  csrf?: string,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(`/personal/api/${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-kora-csrf': csrf } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const code: string | null = typeof data?.error?.code === 'string' ? data.error.code : null;
    if ((response.status === 401 || response.status === 403) && code && expiredCodes.has(code)) {
      const expired = new SessionExpiredError(response.status, code);
      window.dispatchEvent(new CustomEvent(sessionExpiredEvent));
      throw expired;
    }
    throw new ConsumerRequestError(
      data?.error?.message ?? 'We could not connect. Please try again.',
      response.status,
      code,
    );
  }
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
/** Start a profile draft from defaults so null server fields never become ''. */
export function profileDraft(value: Partial<Record<string, unknown>> = {}) {
  const draft: Record<string, unknown> = { ...emptyProfile };
  for (const [key, field] of Object.entries(value)) if (field !== null && field !== undefined) draft[key] = field;
  return draft;
}
export function profilePayload(value: any) {
  return Object.fromEntries(
    profileKeys.map((key) => [key, value[key] || (emptyProfile as Record<string, unknown>)[key] || (key === 'nationality' ? null : '')]),
  );
}
