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
const MONCASH_MODE = (process.env.MONCASH_MODE || "sandbox").toLowerCase();

const IS_PRODUCTION = MONCASH_MODE === "live" || MONCASH_MODE === "production";
const BASE_DOMAIN = IS_PRODUCTION 
    ? "https://moncashbutton.digicelgroup.com" 
    : "https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware";

// URLs de base pour les appels API
const BASE_URL_API = BASE_DOMAIN;
const BASE_URL_REDIRECT = `${BASE_DOMAIN}/Moncash-middleware`;

// Vérification de sécurité
if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("ERREUR CRITIQUE : MONCASH_CLIENT_ID ou MONCASH_CLIENT_SECRET manquant !");
} else {
    console.log(`Initialisation MonCash en mode : ${MONCASH_MODE.toUpperCase()}`);
    console.log(`URL de base : ${BASE_DOMAIN}`);
}

const qs = require('querystring');

async function getAccessToken() {
    const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    
    // Utilisation de querystring pour s'assurer de l'encodage strict
    const data = qs.stringify({
        grant_type: 'client_credentials',
        scope: 'read write'
    });
    
    try {
        const url = `${BASE_DOMAIN}/oauth/token`;
        console.log(`ID: ${CLIENT_ID.substring(0, 4)}... (len: ${CLIENT_ID.length}), Secret: (len: ${CLIENT_SECRET.length})`);
        console.log(`Appel OAuth: ${url}`);
        
        const response = await axios.post(url, data, {
            headers: {
                'Authorization': `Basic ${authString}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'MonCash-Node-Client/1.0'
            },
            timeout: 30000
        });
        return response.data;
    } catch (error) {
        if (error.response?.status === 404) {
             const fallbackUrl = `${BASE_DOMAIN}/Api/oauth/token`;
             console.log(`Repli sur fallback: ${fallbackUrl}`);
             const response = await axios.post(fallbackUrl, data, {
                headers: {
                    'Authorization': `Basic ${authString}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'MonCash-Node-Client/1.0'
                },
                timeout: 30000
            });
            return response.data;
        }
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
        
        if (!accessToken) {
             return res.status(500).json({ error: "Token non reçu.", details: tokenData });
        }

        // Création du paiement
        // On essaie d'abord sans /Api, puis avec /Api si 404
        let paymentResponse;
        try {
            paymentResponse = await axios.post(
                `${BASE_URL_API}/v1/CreatePayment`,
                { 
                    amount: parseFloat(amount), 
                    orderId: orderId.toString()
                },
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );
        } catch (error) {
            if (error.response?.status === 404) {
                console.log("Tentative de repli sur /Api/v1/CreatePayment...");
                paymentResponse = await axios.post(
                    `${BASE_URL_API}/Api/v1/CreatePayment`,
                    { 
                        amount: parseFloat(amount), 
                        orderId: orderId.toString()
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 30000
                    }
                );
            } else {
                throw error;
            }
        }

        // Le format du token peut varier selon la version (direct string ou objet)
        const pToken = paymentResponse.data.payment_token;
        const tokenString = (typeof pToken === 'object') ? pToken.token : pToken;
        
        const redirectUrl = `${BASE_URL_REDIRECT}/Payment/Redirect?token=${tokenString}`;

        return res.status(200).json({
            success: true,
            redirect_url: redirectUrl,
            payment_token: tokenString,
            details: paymentResponse.data
        });
    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("Erreur CreatePayment:", JSON.stringify(details, null, 2));
        return res.status(500).json({
            error: "Erreur lors de la création du paiement MonCash.",
            details: details
        });
    }
});

app.get('/verifypayment', async (req, res) => {
    try {
        const { orderId } = req.query;
        if (!orderId) return res.status(400).json({ error: "orderId manquant." });
        
        const tokenData = await getAccessToken();
        const accessToken = tokenData.access_token;

        // On essaie CheckPayment ou RetrieveOrderPayment
        const verifyResponse = await axios.post(
            `${BASE_URL_API}/v1/RetrieveOrderPayment`,
            { orderId: orderId.toString() },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        const paymentData = verifyResponse.data.payment || {};
        
        return res.status(200).json({
            success: true,
            status: paymentData.message || "inconnu",
            transactionId: paymentData.transaction_id,
            reference: paymentData.reference
        });
    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("Erreur verifypayment:", JSON.stringify(details));
        return res.status(500).json({ error: "Erreur verification.", details: details });
    }
});

app.get('/test-auth', async (req, res) => {
    const results = [];
    const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    
    // Combinaisons à tester
    const scopes = ['read write', 'read,write', 'read', 'write'];
    const urls = [
        `${BASE_DOMAIN}/oauth/token`,
        `${BASE_DOMAIN}/Api/oauth/token`,
        "https://sandbox.moncashbutton.digicelgroup.com/oauth/token",
        "https://moncashbutton.digicelgroup.com/Api/oauth/token"
    ];

    for (const url of urls) {
        for (const scope of scopes) {
            try {
                const data = qs.stringify({ grant_type: 'client_credentials', scope });
                const resp = await axios.post(url, data, {
                    headers: {
                        'Authorization': `Basic ${authString}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0'
                    },
                    timeout: 5000
                });
                results.push({ url, scope, status: resp.status, data: resp.data });
            } catch (e) {
                results.push({ url, scope, status: e.response?.status || 'ERROR', error: e.response?.data || e.message });
            }
        }
    }
    res.json({ config: { mode: MONCASH_MODE, id_len: CLIENT_ID.length, secret_len: CLIENT_SECRET.length }, results });
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
    https.get(RENDER_EXTERNAL_URL, (res) => {
        // Ping discret
    }).on('error', (e) => {
        console.error(`Erreur Keep-alive : ${e.message}`);
    });
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Serveur Unified Merchant MonCash actif sur le port ${PORT}`));
