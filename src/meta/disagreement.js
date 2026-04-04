const db = require('../db');

module.exports.detectDisagreements = async (conversation_id) => {
    const annotations = await db.execute('SELECT * FROM annotations WHERE conversation_id = ?', [conversation_id]);

    const grouped = {};
    for (const a of annotations) {
        if (!grouped[a.annotation_type]) grouped[a.annotation_type] = [];
        grouped[a.annotation_type].push(a);
    }

    const results = [];
    for (const [type, annos] of Object.entries(grouped)) {
        const labels = annos.map(a => a.label);
        const uniqueLabels = [...new Set(labels)];

        const counts = {};
        for (const l of labels) {
            counts[l] = (counts[l] || 0) + 1;
        }
        const maxCount = Math.max(...Object.values(counts));
        const agreement_ratio = labels.length > 0 ? (maxCount / labels.length) : 1;

        results.push({
            annotation_type: type,
            labels,
            agreement_ratio,
            needs_tiebreaker: uniqueLabels.length > 1 && agreement_ratio <= 0.5
        });
    }
    return results;
};

module.exports.getDisputedConversations = async (days) => {
    let query = 'SELECT DISTINCT conversation_id FROM annotations WHERE 1=1';
    const params = [];
    if (days) {
        query += ' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
        params.push(String(days));
    }

    const convs = await db.execute(query, params);
    const disputed = [];

    for (const c of convs) {
        const d = await module.exports.detectDisagreements(c.conversation_id);
        if (d.some(x => x.needs_tiebreaker || x.agreement_ratio < 1)) {
            disputed.push({ conversation_id: c.conversation_id, disagreements: d });
        }
    }
    return disputed;
};

module.exports.resolveDisagreement = async (conversation_id, annotation_type, resolved_label, resolver_id) => {
    const result = await db.execute(
        `INSERT INTO annotations (conversation_id, annotator_id, annotation_type, label, confidence, notes) 
     VALUES (?, ?, ?, ?, ?, ?)`,
        [
            conversation_id,
            resolver_id,
            annotation_type,
            resolved_label,
            1.0,
            'tiebreaker resolution'
        ]
    );

    return {
        id: result.insertId,
        conversation_id,
        annotation_type,
        resolved_label,
        resolver_id,
        notes: 'tiebreaker resolution'
    };
};
