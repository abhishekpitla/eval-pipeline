const express = require('express');
const config = require('./config');

const healthRoutes = require('./routes/health');
const conversationsRoutes = require('./routes/conversations');
const feedbackRoutes = require('./routes/feedback');
const evaluationsRoutes = require('./routes/evaluations');
const metaRoutes = require('./routes/meta');
const suggestionsRoutes = require('./routes/suggestions');
const jobsRoutes = require('./routes/jobs');

const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use('/api/health', healthRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/evaluations', evaluationsRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/suggestions', suggestionsRoutes);
app.use('/api/jobs', jobsRoutes);

if (require.main === module) {
    app.listen(config.port, () => {
        console.log(`Pipeline API server listening on port ${config.port}`);
    });
}

module.exports = app;
