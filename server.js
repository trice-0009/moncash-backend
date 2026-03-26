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
    : "https://sandbox.moncashbutton.digicelgroup.com";

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

async function getAccessToken() {
    const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    
    // Le scope doit être séparé par un espace "read write" pour la nouvelle API
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('scope', 'read write'); 
    
    try {
        // L'endpoint OAuth est généralement direct sous le domaine
        const response = await axios.post(`${BASE_DOMAIN}/oauth/token`, params, {
            headers: {
                'Authorization': `Basic ${authString}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            timeout: 30000
        });
        return response.data;
    } catch (error) {
        // Fallback: Si direct échoue, essayer avec /Api (certains environnements sandbox anciens)
        if (error.response?.status === 404) {
             console.log("Tentative de repli (fallback) sur /Api/oauth/token...");
             const response = await axios.post(`${BASE_DOMAIN}/Api/oauth/token`, params, {
                headers: {
                    'Authorization': `Basic ${authString}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
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
