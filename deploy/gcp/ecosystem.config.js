module.exports = {
  apps: [
    {
      name: 'barsha-backend',
      script: './server.js',
      cwd: '/opt/barsha-backend',
      // Use a single forked instance. The backend starts a background calling
      // queue (startCallingQueue), so running multiple instances would risk
      // duplicate outbound calls.
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 5001,
      },
      // Logs are written relative to cwd unless absolute paths are provided.
      error_file: '/var/log/barsha-backend/err.log',
      out_file: '/var/log/barsha-backend/out.log',
      log_file: '/var/log/barsha-backend/combined.log',
      time: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
    },
  ],
};
