require('dotenv').config();
const mongoose = require('mongoose');

const connectToMongo = async () => {
  try {
    const dbUri = process.env.DB_URI || "mongodb://localhost:27017/your_database_name"; 
    await mongoose.connect(dbUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected!');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
};

module.exports = connectToMongo;
