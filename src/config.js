require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'eval_pipeline'
  },
  openaiApiKey: process.env.OPENAI_API_KEY
};
