export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

// --- Phase 03: videos (see phase-03-videos Error Catalog) ---

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class ForbiddenVideoAccessException extends DomainException {
  constructor() {
    super('FORBIDDEN_VIDEO_ACCESS', 403, 'You do not own this video');
  }
}

export class UploadTooLargeException extends DomainException {
  constructor() {
    super('UPLOAD_TOO_LARGE', 413, 'Upload exceeds the maximum allowed size');
  }
}

export class UploadNotCompletableException extends DomainException {
  constructor() {
    super(
      'UPLOAD_NOT_COMPLETABLE',
      409,
      'Upload cannot be completed in the current state',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}

export class InvalidRangeException extends DomainException {
  constructor() {
    super('INVALID_RANGE', 416, 'Requested range not satisfiable');
  }
}
