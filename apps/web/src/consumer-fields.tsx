import { countries } from './consumer-api.js';

// Mirrors services/api/src/consumer.ts profileSchema so mistakes are caught before submit.
const rules: Record<string, { maxLength: number; minLength?: number; pattern?: string; title?: string }> = {
  first_name: { maxLength: 80 },
  last_name: { maxLength: 80 },
  username: {
    maxLength: 24,
    minLength: 3,
    pattern: '[A-Za-z][A-Za-z0-9_]{2,23}',
    title: 'Use 3–24 letters, numbers or underscores, starting with a letter',
  },
  phone: {
    maxLength: 20,
    pattern: '\\+[1-9][0-9 \\(\\)\\-]{6,19}',
    title: 'Include the country code, for example +234',
  },
  address_line1: { maxLength: 160, minLength: 3 },
  address_line2: { maxLength: 160 },
  city: { maxLength: 80 },
  region: { maxLength: 80 },
  postal_code: { maxLength: 20 },
  occupation: { maxLength: 80 },
};
export function ConsumerFields({
  value,
  set,
  section,
  locked = false,
}: {
  value: any;
  set: (key: string, value: string) => void;
  section: 'identity' | 'address';
  locked?: boolean;
}) {
  const field = (
    key: string,
    label: string,
    type = 'text',
    placeholder = '',
    autoComplete?: string,
    disabled = false,
  ) => (
    <label key={key}>
      {label}
      <input
        name={key}
        type={type}
        value={value[key] ?? ''}
        onChange={(e) => set(key, e.target.value)}
        required={!['address_line2', 'postal_code', 'occupation'].includes(key)}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete={autoComplete}
        maxLength={rules[key]?.maxLength ?? 160}
        minLength={rules[key]?.minLength}
        pattern={rules[key]?.pattern}
        title={rules[key]?.title}
      />
    </label>
  );
  return (
    <div className="fin-fields">
      {section === 'identity' ? (
        <>
          {field(
            'first_name',
            'First name',
            'text',
            'As on your identity document',
            'given-name',
            locked,
          )}
          {field('last_name', 'Last name', 'text', '', 'family-name', locked)}
          {field('username', 'Username', 'text', 'yourname', 'username')}
          {field('phone', 'Phone number', 'tel', '+234 800 000 0000', 'tel')}
          {field('date_of_birth', 'Date of birth', 'date', '', 'bday', locked)}
          <label>
            Country of residence
            <select
              value={value.residence_country ?? 'NG'}
              onChange={(e) => set('residence_country', e.target.value)}
              disabled={locked}
              autoComplete="country"
            >
              {countries.map(([code, label]) => (
                <option value={code} key={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <>
          {field('address_line1', 'Street address', 'text', '', 'address-line1', locked)}
          {field(
            'address_line2',
            'Apartment / suite (optional)',
            'text',
            '',
            'address-line2',
            locked,
          )}
          {field('city', 'City', 'text', '', 'address-level2', locked)}
          {field('region', 'State / region', 'text', '', 'address-level1', locked)}
          {field('postal_code', 'Postal code (optional)', 'text', '', 'postal-code', locked)}
          {field('occupation', 'Occupation (optional)', 'text')}
          <label>
            Nationality (optional)
            <select
              value={value.nationality ?? ''}
              onChange={(e) => set('nationality', e.target.value)}
              disabled={locked}
            >
              <option value="">Select nationality</option>
              {countries.map(([code, label]) => (
                <option value={code} key={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}
