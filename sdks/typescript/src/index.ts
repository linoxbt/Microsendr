import type { components, operations } from './generated.js';
export type { components, operations, paths } from './generated.js';
export type Model<K extends keyof components['schemas']> = components['schemas'][K];
type Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;
export interface MicrosendrOptions {
  baseUrl?: string;
  apiKey?: string;
  csrfToken?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
export class MicrosendrError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string | null,
  ) {
    super(message);
    this.name = 'MicrosendrError';
  }
}
export class Microsendr {
  constructor(private options: MicrosendrOptions = {}) {}
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    if (this.options.csrfToken) headers['x-kora-csrf'] = this.options.csrfToken;
    if (body !== undefined) {
      if (!idempotencyKey) throw new Error('Mutations require an idempotency key');
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = idempotencyKey;
    }
    const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl ?? ''}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new MicrosendrError(
        response.status,
        data.error?.code ?? 'request_failed',
        data.error?.message ?? 'Request failed',
        response.headers.get('x-request-id'),
      );
    return data as T;
  }
  async *paginate<T>(
    list: (query: Record<string, string>) => Promise<{ data: T[]; next_cursor: string | null }>,
    query: Record<string, string> = {},
  ) {
    let after: string | null = null;
    do {
      const page = await list({ ...query, ...(after ? { after } : {}) });
      yield* page.data;
      after = page.next_cursor;
    } while (after);
  }
  getNetworkRouting = (amount_minor: string) =>
    this.request<Model<'NetworkRouting'>>(
      'GET',
      `/v1/network/routing?${new URLSearchParams({ amount_minor })}`,
    );
  recordNetworkHealth = (body: Body<'recordNetworkHealth'>, key: string) =>
    this.request<Model<'NetworkHealthObservation'>>('POST', '/v1/network/health', body, key);
  getNetwork = () => this.request<Model<'NetworkRegistry'>>('GET', '/v1/network');
  listNetworkPlans = () => this.request<Model<'NetworkPlanList'>>('GET', '/v1/network/plans');
  getNetworkPlan = (id: string) =>
    this.request<Model<'NetworkPlan'>>('GET', `/v1/network/plans/${encodeURIComponent(id)}`);
  createNetworkQuote = (body: Body<'createNetworkQuote'>, key: string) =>
    this.request<Model<'NetworkQuote'>>('POST', '/v1/network/quotes', body, key);
  createNetworkIntent = (body: Body<'createNetworkIntent'>, key: string) =>
    this.request<Model<'Intent'>>('POST', '/v1/network/intents', body, key);
  getControls = () => this.request<Model<'ControlStatus'>>('GET', '/v1/controls');
  listControlEvidence = () =>
    this.request<Model<'ControlEvidenceList'>>('GET', '/v1/controls/evidence');
  createControlEvidence = (body: Body<'createControlEvidence'>, key: string) =>
    this.request<Model<'ControlEvidence'>>('POST', '/v1/controls/evidence', body, key);
  listControlApprovals = () =>
    this.request<Model<'ControlApprovalList'>>('GET', '/v1/controls/approvals');
  createControlApproval = (body: Body<'createControlApproval'>, key: string) =>
    this.request<Model<'ControlApproval'>>('POST', '/v1/controls/approvals', body, key);
  reviewControlApproval = (id: string, body: Body<'reviewControlApproval'>, key: string) =>
    this.request<Model<'ControlApproval'>>(
      'POST',
      `/v1/controls/approvals/${encodeURIComponent(id)}/review`,
      body,
      key,
    );
  pausePayments = (reason: string, key: string) =>
    this.request<Model<'ControlPause'>>('POST', '/v1/controls/pause', { reason }, key);
  listDailyReports = () => this.request<Model<'ControlReportList'>>('GET', '/v1/controls/reports');
  createDailyReport = (day: string, key: string) =>
    this.request<Model<'ControlReport'>>('POST', '/v1/controls/reports', { day }, key);
  listControlAudit = () => this.request<Model<'ControlAuditList'>>('GET', '/v1/controls/audit');
  getStellarStatus = () => this.request<Model<'StellarStatus'>>('GET', '/v1/stellar');
  getStellarChallenge = (id: string, address: string) =>
    this.request<Model<'StellarChallenge'>>(
      'GET',
      `/v1/customers/${encodeURIComponent(id)}/stellar_challenge?${new URLSearchParams({ address })}`,
    );
  createStellarAccount = (id: string, body: Body<'createStellarAccount'>, key: string) =>
    this.request<Model<'StellarAccount'>>(
      'POST',
      `/v1/customers/${encodeURIComponent(id)}/stellar_accounts`,
      body,
      key,
    );
  listStellarAccounts = (id: string) =>
    this.request<Model<'StellarAccountList'>>(
      'GET',
      `/v1/customers/${encodeURIComponent(id)}/stellar_accounts`,
    );
  createStellarPurchase = (body: Body<'createStellarPurchase'>, key: string) =>
    this.request<Model<'Intent'>>('POST', '/v1/stellar/purchases', body, key);
  verifyStellarDeposit = (body: Body<'verifyStellarDeposit'>, key: string) =>
    this.request<Model<'StellarDeposit'>>('POST', '/v1/stellar/deposits', body, key);
  listStellarDeposits = () =>
    this.request<Model<'StellarDepositList'>>('GET', '/v1/stellar/deposits');
  redeemStellarBalance = (body: Body<'redeemStellarBalance'>, key: string) =>
    this.request<Model<'StellarRedemption'>>('POST', '/v1/stellar/redemptions', body, key);
  listStellarRedemptions = () =>
    this.request<Model<'StellarRedemptionList'>>('GET', '/v1/stellar/redemptions');
  getRailStatus = () => this.request<Model<'RailStatus'>>('GET', '/v1/rails');
  listBanks = () => this.request<Model<'BankList'>>('GET', '/v1/banks');
  resolveBank = (body: Body<'resolveBank'>, key: string) =>
    this.request<Model<'BankResolution'>>('POST', '/v1/bank_resolutions', body, key);
  createBankAccount = (id: string, body: Body<'createBankAccount'>, key: string) =>
    this.request<Model<'BankAccount'>>(
      'POST',
      `/v1/customers/${encodeURIComponent(id)}/bank_accounts`,
      body,
      key,
    );
  listBankAccounts = (id: string) =>
    this.request<Model<'BankAccountList'>>(
      'GET',
      `/v1/customers/${encodeURIComponent(id)}/bank_accounts`,
    );
  createLocalPayout = (body: Body<'createLocalPayout'>, key: string) =>
    this.request<Model<'Intent'>>('POST', '/v1/local_payouts', body, key);
  verifyLocalPayout = (id: string, key: string) =>
    this.request<Model<'Recovery'>>(
      'POST',
      `/v1/local_payouts/${encodeURIComponent(id)}/verify`,
      {},
      key,
    );
  createCollection = (body: Body<'createCollection'>, key: string) =>
    this.request<Model<'Collection'>>('POST', '/v1/collections', body, key);
  listCollections = (query: Record<string, string> = {}) =>
    this.request<Model<'CollectionList'>>('GET', `/v1/collections?${new URLSearchParams(query)}`);
  getCollection = (id: string) =>
    this.request<Model<'Collection'>>('GET', `/v1/collections/${encodeURIComponent(id)}`);
  verifyCollection = (id: string, key: string) =>
    this.request<Model<'CollectionRecovery'>>(
      'POST',
      `/v1/collections/${encodeURIComponent(id)}/verify`,
      {},
      key,
    );
  releaseCollection = (id: string, key: string) =>
    this.request<Model<'Collection'>>(
      'POST',
      `/v1/collections/${encodeURIComponent(id)}/release`,
      {},
      key,
    );
  setComplianceDecision = (id: string, body: Body<'setComplianceDecision'>, key: string) =>
    this.request<Model<'ComplianceDecision'>>(
      'POST',
      `/v1/customers/${encodeURIComponent(id)}/compliance_decisions`,
      body,
      key,
    );
  listComplianceDecisions = (id: string) =>
    this.request<Model<'ComplianceList'>>(
      'GET',
      `/v1/customers/${encodeURIComponent(id)}/compliance_decisions`,
    );
  createStatement = (key: string) =>
    this.request<Model<'Statement'>>('POST', '/v1/operations/statements', {}, key);
  listStatements = (query: Record<string, string> = {}) =>
    this.request<Model<'StatementList'>>(
      'GET',
      `/v1/operations/statements?${new URLSearchParams(query)}`,
    );
  getStatement = (id: string) =>
    this.request<Model<'StatementDetail'>>(
      'GET',
      `/v1/operations/statements/${encodeURIComponent(id)}`,
    );
  getMerchant = () => this.request<Model<'Merchant'>>('GET', '/v1/me');
  listAssets = () => this.request<Model<'AssetList'>>('GET', '/v1/assets');
  listBalances = () => this.request<Model<'BalanceList'>>('GET', '/v1/balances');
  getOverview = (days = 7) =>
    this.request<Model<'Overview'>>('GET', `/v1/console/overview?days=${days}`);
  listCustomers = (query: Record<string, string> = {}) =>
    this.request<Model<'CustomerList'>>('GET', `/v1/customers?${new URLSearchParams(query)}`);
  createCustomer = (body: Body<'createCustomer'>, key: string) =>
    this.request<Model<'Customer'>>('POST', '/v1/customers', body, key);
  getCustomer = (id: string) =>
    this.request<Model<'Customer'>>('GET', `/v1/customers/${encodeURIComponent(id)}`);
  getQuote = (id: string) =>
    this.request<Model<'Quote'>>('GET', `/v1/quotes/${encodeURIComponent(id)}`);
  listInstruments = (id: string, query: Record<string, string> = {}) =>
    this.request<Model<'InstrumentList'>>(
      'GET',
      `/v1/customers/${encodeURIComponent(id)}/instruments?${new URLSearchParams(query)}`,
    );
  createInstrument = (id: string, body: Body<'createInstrument'>, key: string) =>
    this.request<Model<'Instrument'>>(
      'POST',
      `/v1/customers/${encodeURIComponent(id)}/instruments`,
      body,
      key,
    );
  createQuote = (body: Body<'createQuote'>, key: string) =>
    this.request<Model<'Quote'>>('POST', '/v1/quotes', body, key);
  createIntent = (body: Body<'createIntent'>, key: string) =>
    this.request<Model<'Intent'>>('POST', '/v1/intents', body, key);
  getIntent = (id: string) =>
    this.request<Model<'Intent'>>('GET', `/v1/intents/${encodeURIComponent(id)}`);
  listIntents = (query: Record<string, string> = {}) =>
    this.request<Model<'IntentList'>>('GET', `/v1/intents?${new URLSearchParams(query)}`);
  cancelIntent = (id: string, key: string) =>
    this.request<Model<'Intent'>>('POST', `/v1/intents/${encodeURIComponent(id)}/cancel`, {}, key);
  listEvents = (query: Record<string, string> = {}) =>
    this.request<Model<'EventList'>>('GET', `/v1/events?${new URLSearchParams(query)}`);
  listWebhookEndpoints = (query: Record<string, string> = {}) =>
    this.request<Model<'EndpointList'>>(
      'GET',
      `/v1/webhook_endpoints?${new URLSearchParams(query)}`,
    );
  createWebhookEndpoint = (url: string, key: string) =>
    this.request<Model<'WebhookEndpoint'>>('POST', '/v1/webhook_endpoints', { url }, key);
  disableWebhookEndpoint = (id: string, key: string) =>
    this.request<Model<'DisabledEndpoint'>>(
      'POST',
      `/v1/webhook_endpoints/${encodeURIComponent(id)}/disable`,
      {},
      key,
    );
  listWebhookDeliveries = () =>
    this.request<Model<'DeliveryList'>>('GET', '/v1/webhook_deliveries');
  replayEvent = (id: string, key: string) =>
    this.request<Model<'Replay'>>('POST', `/v1/events/${encodeURIComponent(id)}/replay`, {}, key);
  listApiKeys = (query: Record<string, string> = {}) =>
    this.request<Model<'KeyList'>>('GET', `/v1/api_keys?${new URLSearchParams(query)}`);
  createApiKey = (body: Body<'createApiKey'>, key: string) =>
    this.request<Model<'KeyCreated'>>('POST', '/v1/api_keys', body, key);
  revokeApiKey = (id: string, key: string) =>
    this.request<Model<'ApiKey'>>('POST', `/v1/api_keys/${encodeURIComponent(id)}/revoke`, {}, key);
  listRequestLogs = () => this.request<Model<'RequestLogList'>>('GET', '/v1/request_logs');
  listReconciliation = () =>
    this.request<Model<'ReconciliationList'>>('GET', '/v1/operations/reconciliation');
  getOperationDetail = (id: string) =>
    this.request<Model<'OperationDetail'>>(
      'GET',
      `/v1/operations/intents/${encodeURIComponent(id)}`,
    );
  recoverIntent = (id: string, key: string) =>
    this.request<Model<'Recovery'>>(
      'POST',
      `/v1/operations/intents/${encodeURIComponent(id)}/recover`,
      {},
      key,
    );
}
