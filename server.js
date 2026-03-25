const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = "21706f2f287c9aa32059dce31524df55";
const CLIENT_SECRET = "ILCKYtja_-SBWUU1hq3m_5ohG3PrrE_KzG8TjQjCO6-GdR8DKfJuc42HiNVzzwCV";
const BASE_URL = "https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware";

async function getAccessToken() {
    const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const params = new URLSearchParams();
    params.append('scope', 'read,write');
    params.append('grant_type', 'client_credentials');
    const response = await axios.post(`${BASE_URL}/oauth/token`, params, {
        headers: {
            'Authorization': `Basic ${authString}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
    return response.data.access_token;
}

app.post('/createpayment', async (req, res) => {
    try {
        const { amount, orderId } = req.body;
        if (!amount || !orderId) return res.status(400).json({ error: "Montant ou orderId manquant." });
        const token = await getAccessToken();
        const paymentResponse = await axios.post(`${BASE_URL}/v1/CreatePayment`,
            { amount: parseInt(amount), orderId: orderId.toString() },
            { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        return res.status(200).json({
            success: true,
            paymentToken: paymentResponse.data.payment_token.token,
            redirectUrl: `${BASE_URL}/Payment/Redirect?token=${paymentResponse.data.payment_token.token}`
        });
    } catch (error) {
        return res.status(500).json({ error: "Erreur creation paiement.", details: error.message });
    }
});

app.get('/verifypayment', async (req, res) => {
    try {
        const { orderId } = req.query;
        if (!orderId) return res.status(400).json({ error: "orderId manquant." });
        const token = await getAccessToken();
        const verifyResponse = await axios.post(`${BASE_URL}/v1/RetrieveOrderPayment`,
            { orderId: orderId.toString() },
            { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        const p = verifyResponse.data.payment;
        return res.status(200).json({
            success: true,
            status: p.message,
            transactionId: p.transaction_id,
            reference: p.reference
        });
    } catch (error) {
        return res.status(500).json({ error: "Erreur verification.", details: error.message });
    }
});

app.get('/', (req, res) => res.send('MonCash Backend OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur MonCash actif sur le port ${PORT}`));
