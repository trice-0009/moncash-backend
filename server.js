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

const CLIENT_ID = "21706f2f287c9aa32059dce31524df55";
const CLIENT_SECRET = "ILCKYtja_-SBWUU1hq3m_5ohG3PrrE_KzG8TjQjCO6-GdR8DKfJuc42HiNVzzwCV";
// Utilisation de la Merchant API pour les paiements directs
const BASE_URL = "https://sandbox.moncashbutton.digicelgroup.com/MerChantApi";

async function getAccessToken() {
    const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    
    // On n'envoie que "grant_type" dans le corps (Body) comme dans la Version PRO
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    
    const response = await axios.post(`${BASE_URL}/oauth/token`, params, {
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
 * Endpoint de création de paiement direct (Merchant API)
 * Reçoit : { amount, orderId, account }
 */
app.post('/createpayment', async (req, res) => {
    try {
        const { amount, orderId, account } = req.body;
        if (!amount || !orderId || !account) {
            return res.status(400).json({ error: "Montant, orderId ou compte MonCash manquant." });
        }

        const tokenData = await getAccessToken();
        if (!tokenData.access_token) {
            return res.status(500).json({ error: "Impossible de récupérer le token.", details: tokenData });
        }
        
        const accessToken = tokenData.access_token;
        
        // Appel à l'API InitiatePayment (V1) de la Merchant API
        const paymentResponse = await axios.post(
            `${BASE_URL}/V1/InitiatePayment`,
            { 
                amount: parseFloat(amount), 
                reference: orderId.toString(),
                account: account.toString() 
            },
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
            status: paymentResponse.data.message,
            transactionId: paymentResponse.data.transactionId,
            details: paymentResponse.data
        });
    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("Erreur Merchant Payment:", JSON.stringify(details));
        return res.status(500).json({
            error: "Erreur lors de l'initiation du paiement.",
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
            `${BASE_URL}/V1/CheckPayment`,
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
