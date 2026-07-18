const { Queue } = require('bullmq');
const IORedis = require('ioredis');

let connection;
let emailSendQueue;
let leadImportQueue;

function createQueueJobId(...parts) {
  return parts
    .map(part => String(part ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-'))
    .filter(Boolean)
    .join('-');
}

function getRedisConnection() {
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is required');
  }

  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
  }

  return connection;
}

function getEmailSendQueue() {
  if (!emailSendQueue) {
    emailSendQueue = new Queue('email-send', {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60000,
        },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
  }

  return emailSendQueue;
}

function getLeadImportQueue() {
  if (!leadImportQueue) {
    leadImportQueue = new Queue('lead-import', {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
  }
  return leadImportQueue;
}

module.exports = {
  createQueueJobId,
  getEmailSendQueue,
  getLeadImportQueue,
  getRedisConnection,
};
