const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

// Servir les fichiers statiques (le mini-site) depuis le dossier 'public'
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURATION MONCASH ---
const CLIENT_ID = (process.env.MONCASH_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.MONCASH_CLIENT_SECRET || "").trim();
const MONCASH_ACCOUNT = (process.env.MONCASH_ACCOUNT || "").trim();
const MONCASH_MODE = (process.env.MONCASH_MODE || "sandbox").toLowerCase();

const IS_PRODUCTION = MONCASH_MODE === "live" || MONCASH_MODE === "production";

// BASE_DOMAIN est configuré selon le mode détecté (Le diagnostic a confirmé MerChantApi pour le Sandbox)
const BASE_DOMAIN = IS_PRODUCTION 
    ? "https://moncashbutton.digicelgroup.com/Api" 
    : "https://sandbox.moncashbutton.digicelgroup.com/MerChantApi";

const BASE_URL_REDIRECT = IS_PRODUCTION
    ? "https://moncashbutton.digicelgroup.com/Moncash-middleware"
    : "https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware";

// Vérification de sécurité
if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("ERREUR CRITIQUE : MONCASH_CLIENT_ID ou MONCASH_CLIENT_SECRET manquant sur Render !");
} else {
    console.log(`Serveur MonCash initialisé en mode ${MONCASH_MODE.toUpperCase()}`);
}

const qs = require('querystring');

async function getAccessToken() {
    const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const data = qs.stringify({
        grant_type: 'client_credentials',
        scope: 'read write'
    });
    
    try {
        const response = await axios.post(`${BASE_DOMAIN}/oauth/token`, data, {
            headers: {
                'Authorization': `Basic ${authString}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'MonCash-Node-Client'
            },
            timeout: 30000
        });
        return response.data;
    } catch (error) {
        console.error("Erreur Auth:", error.response?.data || error.message);
        throw error;
    }
}

/**
 * Endpoint de création de paiement
 */
app.post('/createpayment', async (req, res) => {
    try {
        const { amount, orderId } = req.body;
        if (!amount || !orderId) {
            return res.status(400).json({ error: "Montant ou orderId manquant." });
        }

        const tokenData = await getAccessToken();
        const accessToken = tokenData.access_token;
        
        // On essaie les deux versions possibles de l'API MonCash (New vs Legacy)
        let paymentResponse;
        try {
            // Version Legacy (Merchant API / Sandbox habituelle)
            // Attend "reference" au lieu de "orderId", et nécessite le champ "account" (numéro marchand)
            paymentResponse = await axios.post(
                `${BASE_DOMAIN}/V1/InitiatePayment`,
                { 
                    amount: parseFloat(amount), 
                    reference: orderId.toString(),
                    account: MONCASH_ACCOUNT 
                },
                {
                    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                    timeout: 30000
                }
            );
        } catch (e) {
            if (e.response?.status === 404 || e.response?.status === 400) {
                console.log("Tentative de repli sur v1/CreatePayment...");
                paymentResponse = await axios.post(
                    `${BASE_DOMAIN}/v1/CreatePayment`,
                    { amount: parseFloat(amount), orderId: orderId.toString() },
                    {
                        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                        timeout: 30000
                    }
                );
            } else { throw e; }
        }

        // Extraction robuste du token (objet ou string selon API)
        const pToken = paymentResponse.data.payment_token;
        const tokenString = (typeof pToken === 'object') ? pToken.token : pToken;
        
        const redirectUrl = `${BASE_URL_REDIRECT}/Payment/Redirect?token=${tokenString}`;

        return res.status(200).json({
            success: true,
            redirect_url: redirectUrl,
            payment_token: tokenString
        });
    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("Erreur CreatePayment:", JSON.stringify(details));
        return res.status(500).json({ error: "Erreur MonCash", details });
    }
});

app.get('/verifypayment', async (req, res) => {
    try {
        const { orderId } = req.query;
        if (!orderId) return res.status(400).json({ error: "orderId manquant." });
        
        const tokenData = await getAccessToken();
        const accessToken = tokenData.access_token;

        const verifyResponse = await axios.post(
            `${BASE_DOMAIN}/V1/RetrieveTransactionPayment`,
            { transactionId: "", orderId: orderId.toString() },
            {
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                timeout: 30000
            }
        ).catch(() => axios.post(
            `${BASE_DOMAIN}/V1/CheckPayment`,
            { reference: orderId.toString() },
            {
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                timeout: 30000
            }
        ));

        const paymentData = verifyResponse.data.payment || verifyResponse.data;
        
        return res.status(200).json({
            success: true,
            status: paymentData.message || "inconnu",
            transactionId: paymentData.transaction_id,
            reference: paymentData.reference
        });
    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("Erreur verifypayment:", JSON.stringify(details));
        return res.status(500).json({ error: "Erreur verification", details });
    }
});

app.post('/webhook', (req, res) => {
    console.log("Notification MonCash reçue :", req.body);
    res.status(200).send("OK");
});

app.get('/success', (req, res) => {
    res.send(`
        <div style="text-align:center; padding:50px; font-family:sans-serif;">
            <h1 style="color:#2f855a;">Paiement Réussi !</h1>
            <p>Merci pour votre achat. Vous pouvez retourner dans l'application.</p>
        </div>
    `);
});

const RENDER_EXTERNAL_URL = "https://moncash-backend-5ez9.onrender.com";
setInterval(() => {
    https.get(RENDER_EXTERNAL_URL, (res) => {}).on('error', (e) => {});
}, 10 * 60 * 1000);

app.get('/test-pay', async (req, res) => {
    try {
        const tokenData = await getAccessToken();
        const accessToken = tokenData.access_token;
        const orderId = "TEST_" + Date.now();
        
        const combinations = [
            { name: "Merchant API (ref+acc)", url: `${BASE_DOMAIN}/V1/InitiatePayment`, payload: { amount: 10, reference: orderId, account: MONCASH_ACCOUNT } },
            { name: "Merchant API (ref only)", url: `${BASE_DOMAIN}/V1/InitiatePayment`, payload: { amount: 10, reference: orderId } },
            { name: "Merchant API (ordId only)", url: `${BASE_DOMAIN}/V1/InitiatePayment`, payload: { amount: 10, orderId } }
        ];

        const results = [];
        for (const item of combinations) {
            try {
                const resp = await axios.post(item.url, item.payload, {
                    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                    timeout: 10000
                });
                results.push({ name: item.name, status: resp.status, data: resp.data });
            } catch (e) {
                results.push({ name: item.name, error: e.response?.data || e.message });
            }
        }
        res.json({ accountUsed: MONCASH_ACCOUNT, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Serveur MonCash actif sur le port ${PORT}`));

