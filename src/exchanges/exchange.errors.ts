/**
 * Errors shared by every exchange adapter.
 */

export class ExchangeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExchangeConfigurationError";
  }
}

export class UnsupportedOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedOperationError";
  }
}

/**
 * Thrown whenever an order would be submitted while the environment is not
 * explicitly cleared for live trading. Never bypass this check.
 */
export class OrderSubmissionBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderSubmissionBlockedError";
  }
}
