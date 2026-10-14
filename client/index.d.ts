export interface Address {
    name: string;
    address: string;
}

export interface Attachment {
    id: number;
    filename: string;
    contentType: string;
    size: number;
    contentId: string | null;
    url: string;
}

export interface EmailSummary {
    id: number;
    messageId: string | null;
    from: Address;
    to: Address[];
    cc: Address[];
    envelope: { from: string; to: string[] };
    subject: string;
    snippet: string;
    size: number;
    attachmentCount: number;
    smtpUser: string | null;
    timestamp: string;
}

export interface Email extends EmailSummary {
    text: string | null;
    html: string | null;
    headers: { key: string; value: string }[];
    attachments: Attachment[];
    /** The detected one-time code, or null */
    code: string | null;
    /** Every http(s) link in the email */
    links: string[];
}

export interface Filters {
    /** Exact recipient address (To, Cc or the SMTP envelope), case-insensitive */
    to?: string;
    /** Sender address or name contains this */
    from?: string;
    /** Subject contains this */
    subject?: string;
    /** Subject, addresses or text body contains this */
    search?: string;
    /** Only emails received after this time */
    after?: Date | string;
    before?: Date | string;
}

export interface WaitOptions extends Filters {
    /** Seconds to wait (default 30, at most 120) */
    timeout?: number;
}

export interface Sms {
    id: number;
    sender: string;
    /** Masked (only the last 4 digits) unless `unmask: true` was requested */
    phone: string;
    message: string;
    timestamp: string;
    apiKeyName: string | null;
    /** The detected one-time code, or null */
    code: string | null;
}

export interface SmsFilters {
    /** The exact phone number (spaces, dashes and brackets are ignored) */
    phone?: string;
    /** Message text, phone number or sender contains this */
    search?: string;
    after?: Date | string;
    before?: Date | string;
    /** Return the full phone number */
    unmask?: boolean;
}

export interface ClientOptions {
    /** Default: MESSAGE_SANDBOX_URL, or http://localhost:30005 */
    baseUrl?: string;
    /** A Read key (or the admin token). Default: MESSAGE_SANDBOX_API_KEY */
    apiKey?: string;
    fetch?: typeof fetch;
}

export class EmailTestError extends Error {
    status: number;
}

export class EmailTimeoutError extends EmailTestError {}

export interface Client {
    latestEmail(filters?: Filters): Promise<Email | null>;
    listEmails(options?: Filters & { page?: number; pageSize?: number }): Promise<{
        emails: EmailSummary[];
        totalEmails: number;
        totalPages: number;
        currentPage: number;
    }>;
    getEmail(id: number): Promise<Email>;
    waitForEmail(options?: WaitOptions): Promise<Email>;
    waitForCode(options?: WaitOptions): Promise<string>;
    waitForLink(options?: WaitOptions & { match?: string | RegExp | ((link: string) => boolean) }): Promise<string>;
    /** Needs an admin token. Returns how many emails were deleted. */
    clearInbox(to: string): Promise<number>;
    deleteEmail(id: number): Promise<void>;

    latestSms(filters?: SmsFilters): Promise<Sms | null>;
    listSms(options?: SmsFilters & { page?: number; pageSize?: number }): Promise<{
        messages: Sms[];
        totalMessages: number;
        totalPages: number;
        currentPage: number;
    }>;
    waitForSms(options?: SmsFilters & { timeout?: number }): Promise<Sms>;
    waitForSmsCode(options?: SmsFilters & { timeout?: number }): Promise<string>;
    /** Needs an admin token. Returns how many messages were deleted. */
    clearSms(phone: string): Promise<number>;
}

export function createClient(options?: ClientOptions): Client;
