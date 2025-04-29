const express = require('express');
const app = express();
const port = 5000;
const cors = require('cors');
const qbdRoute = require('./routes/qbRoute');
const connectToMongo = require('./config/db');
require('./service/refreshToken');
connectToMongo();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: '*'
}));

app.use('/api', qbdRoute);

app.listen(port, () => {
  console.log(`QBD Integration app listening on port ${port}`);
});
