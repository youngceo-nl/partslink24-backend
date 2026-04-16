// Typed errors for consistent JSON error responses.

class ServiceError extends Error {
  constructor(message, { code = "service_error", status = 500, details } = {}) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

class UpstreamError extends ServiceError {
  constructor(message, details) {
    super(message, { code: "partslink_upstream", status: 502, details });
    this.name = "UpstreamError";
  }
}

class ValidationError extends ServiceError {
  constructor(message, details) {
    super(message, { code: "validation_error", status: 400, details });
    this.name = "ValidationError";
  }
}

class LoginRequiredError extends ServiceError {
  constructor(message = "Not authenticated with PartsLink24") {
    super(message, { code: "login_required", status: 401 });
    this.name = "LoginRequiredError";
  }
}

module.exports = { ServiceError, UpstreamError, ValidationError, LoginRequiredError };
