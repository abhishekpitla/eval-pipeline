const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true
});

module.exports = {
    pool,
    execute: async (query, params) => {
        const [results] = await pool.execute(query, params);
        return results;
    },
    queryOne: async (query, params) => {
        const [results] = await pool.execute(query, params);
        return results[0];
    }
};
