const { randomUUID } = require('crypto');

function errorMessage(value) {
  if (!value) return null;
  const message = value instanceof Error ? value.message : String(value);
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message;
}

function apiRequestLogger(req, res, next) {
  const startedAt = Date.now();
  const suppliedRequestId = req.headers['x-request-id'];
  req.requestId = typeof suppliedRequestId === 'string' && suppliedRequestId
    ? suppliedRequestId.slice(0, 128)
    : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  let responseError = null;
  const originalJson = res.json.bind(res);
  res.json = body => {
    if (body && typeof body === 'object' && typeof body.error === 'string') {
      responseError = errorMessage(body.error);
    }
    return originalJson(body);
  };

  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/api/')) return;

    const isError = res.statusCode >= 400;
    if (!isError && process.env.LOG_API_REQUESTS !== 'true') return;

    const entry = {
      event: isError ? 'api_request_failed' : 'api_request_completed',
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      origin: req.headers.origin || null,
      error: responseError,
    };

    if (res.statusCode >= 500) console.error(JSON.stringify(entry));
    else if (isError) console.warn(JSON.stringify(entry));
    else console.info(JSON.stringify(entry));
  });

  next();
}

function apiErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  console.error(JSON.stringify({
    event: 'unhandled_api_error',
    requestId: req.requestId || null,
    method: req.method,
    path: req.originalUrl,
    error: errorMessage(error),
    stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack,
  }));

  return res.status(error?.statusCode || error?.status || 500).json({
    error: 'Internal server error',
    requestId: req.requestId || undefined,
  });
}

module.exports = {
  apiErrorHandler,
  apiRequestLogger,
};
