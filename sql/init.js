const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

async function initDB() {
    const connection = await mysql.createConnection({
        host: config.db.host,
        user: config.db.user,
        password: config.db.password,
        multipleStatements: true
    });

    try {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');

        console.log('Running schema.sql...');
        await connection.query(schema);
        console.log('Database initialized successfully.');
    } catch (error) {
        console.error('Error initializing database:', error);
        process.exit(1);
    } finally {
        await connection.end();
    }
}

initDB();
