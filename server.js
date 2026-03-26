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
// Utilisation du chemin REST API officiel (/Api) pour éviter l'erreur 403
const BASE_URL = "https://sandbox.moncashbutton.digicelgroup.com/Api";

async function getAccessToken() {
    const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const params = new URLSearchParams();
    params.append('scope', 'read,write');
    params.append('grant_type', 'client_credentials');
    const response = await axios.post(`${BASE_URL}/oauth/token`, params, {
        headers: {
            'Authorization': `Basic ${authString}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000
    });
    return response.data.access_token;
}

app.post('/createpayment', async (req, res) => {
    try {
        const { amount, orderId } = req.body;
        if (!amount || !orderId) {
            return res.status(400).json({ error: "Montant ou orderId manquant." });
        }

        const cleanOrderId = orderId.toString().replace(/[^a-zA-Z0-9_]/g, '').substring(0, 50);

        const token = await getAccessToken();
        const paymentResponse = await axios.post(
            `${BASE_URL}/v1/CreatePayment`,
            { amount: parseInt(amount), orderId: cleanOrderId },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        return res.status(200).json({
            success: true,
            paymentToken: paymentResponse.data.payment_token.token,
            redirectUrl: `${BASE_URL}/Payment/Redirect?token=${paymentResponse.data.payment_token.token}`
        });
    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("Erreur createpayment:", JSON.stringify(details));
        return res.status(500).json({
            error: "Erreur creation paiement.",
            details: details
        });
    }
});

app.get('/verifypayment', async (req, res) => {
    try {
        const { orderId } = req.query;
        if (!orderId) return res.status(400).json({ error: "orderId manquant." });
        const token = await getAccessToken();
        const verifyResponse = await axios.post(
            `${BASE_URL}/v1/RetrieveOrderPayment`,
            { orderId: orderId.toString() },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        const p = verifyResponse.data.payment;
        return res.status(200).json({
            success: true,
            status: p.message,
            transactionId: p.transaction_id,
            reference: p.reference
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
app.listen(PORT, () => console.log(`Serveur MonCash actif sur le port ${PORT}`));
