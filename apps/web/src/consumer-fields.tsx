import { countries } from './consumer-api.js';
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
        maxLength={key === 'username' ? 24 : key === 'phone' ? 16 : 160}
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
