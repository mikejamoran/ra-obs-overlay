module.exports = {
  apps: [{
    name: 'ra-obs-overlay',
    script: 'server.js',
    env_file: '.env',
    restart_delay: 5000,
    max_restarts: 10,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
