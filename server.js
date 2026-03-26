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

// Remplacez ces valeurs par vos clés de PRODUCTION sur Render (Dashboard -> Environment)
const CLIENT_ID = process.env.MONCASH_CLIENT_ID || "21706f2f287c9aa32059dce31524df55"; // Sandbox par défaut
const CLIENT_SECRET = process.env.MONCASH_CLIENT_SECRET || "ILCKYtja_-SBWUU1hq3m_5ohG3PrrE_KzG8TjQjCO6-GdR8DKfJuc42HiNVzzwCV"; // Sandbox par défaut

// URLs MonCash (Décommentez la version PRODUCTION quand vous êtes prêt)
// const BASE_URL_TOKEN = "https://moncashbutton.digicelgroup.com/MerChantApi";
// const BASE_URL_API = "https://moncashbutton.digicelgroup.com/Api";
// const BASE_URL_REDIRECT = "https://moncashbutton.digicelgroup.com/Moncash-middleware";

const BASE_URL_TOKEN = "https://sandbox.moncashbutton.digicelgroup.com/MerChantApi";
const BASE_URL_API = "https://sandbox.moncashbutton.digicelgroup.com/Api";
const BASE_URL_REDIRECT = "https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware";

async function getAccessToken() {
    const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('scope', 'read write');
    
    const response = await axios.post(`${BASE_URL_TOKEN}/oauth/token`, params, {
        headers: {
            'Authorization': `Basic ${authString}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        },
        timeout: 30000
    });
    return response.data;
}

/**
 * Endpoint de création de paiement (Méthode Redirection / Legacy)
 * Reçoit : { amount, orderId }
 */
app.post('/createpayment', async (req, res) => {
    try {
        const { amount, orderId } = req.body;
        if (!amount || !orderId) {
            return res.status(400).json({ error: "Montant ou orderId manquant." });
        }

        const tokenData = await getAccessToken();
        if (!tokenData.access_token) {
            return res.status(500).json({ error: "Impossible de récupérer le token.", details: tokenData });
        }
        
        const accessToken = tokenData.access_token;
        
        // Appel à l'API v1/CreatePayment (Redirection)
        const paymentResponse = await axios.post(
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

        // Construction de l'URL de redirection
        const paymentToken = paymentResponse.data.payment_token;
        const redirectUrl = `${BASE_URL_REDIRECT}/Payment/Redirect?token=${paymentToken}`;

        return res.status(200).json({
            success: true,
            redirect_url: redirectUrl,
            payment_token: paymentToken,
            details: paymentResponse.data
        });
    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("Erreur CreatePayment:", JSON.stringify(details));
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

        const verifyResponse = await axios.post(
            `${BASE_URL_API}/V1/CheckPayment`,
            { reference: orderId.toString() },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        return res.status(200).json({
            success: true,
            status: verifyResponse.data.message,
            transactionId: verifyResponse.data.transactionId,
            reference: verifyResponse.data.reference
        });
    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("Erreur verifypayment:", JSON.stringify(details));
        return res.status(500).json({ error: "Erreur verification.", details: details });
    }
});

/**
 * Endpoint de Notification (Webhook / Return URL)
 * Appelé par MonCash après un paiement réussi
 */
app.post('/webhook', (req, res) => {
    console.log("Notification MonCash reçue :", req.body);
    // Ici, vous pourriez enregistrer le paiement en base de données
    res.status(200).send("OK");
});

/**
 * Page de succès (Alert URL)
 * Redirigée par MonCash pour dire merci au client
 */
app.get('/success', (req, res) => {
    res.send(`
        <div style="text-align:center; padding:50px; font-family:sans-serif;">
            <h1 style="color:#2f855a;">Paiement Réussi !</h1>
            <p>Merci pour votre achat. Vous pouvez retourner dans l'application.</p>
        </div>
    `);
});

// Automatisation : Keep-alive every 10 minutes to prevent Render sleep
const RENDER_EXTERNAL_URL = "https://moncash-backend-5ez9.onrender.com";
setInterval(() => {
    https.get(RENDER_EXTERNAL_URL, (res) => {
        console.log(`Ping Keep-alive : ${res.statusCode}`);
    }).on('error', (e) => {
        console.error(`Erreur Keep-alive : ${e.message}`);
    });
}, 10 * 60 * 1000); // 10 minutes

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur Unified Merchant MonCash actif sur le port ${PORT}`));
