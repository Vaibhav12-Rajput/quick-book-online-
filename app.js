const express = require('express');
const app = express();
const port = 5000;
const cors = require('cors');
const qbdRoute = require('./routes/qbdRoute');
const connectToMongo = require('./model/db');
require('./service/refreshToken');
connectToMongo();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: '*'
}));

app.use('/api/auth', qbdRoute);

app.listen(port, () => {
  console.log(`QBD Integration app listening on port ${port}`);
});
