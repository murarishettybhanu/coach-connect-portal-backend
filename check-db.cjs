const mongoose = require('mongoose');

async function checkProducts() {
  const uri = 'mongodb+srv://manideeprepala_db_user:wDe0QH6IftXhmSM9@creatorflow.fccmmwq.mongodb.net/shipkit?retryWrites=true&w=majority';
  await mongoose.connect(uri);
  const Product = mongoose.model('Product', new mongoose.Schema({
    name: String,
    retailPrice: Number,
    coachId: mongoose.Schema.Types.ObjectId
  }));

  const products = await Product.find({});
  console.log('Current Products:', JSON.stringify(products, null, 2));
  
  // Also update them to have a default retail price if it's 0
  const result = await Product.updateMany(
    { $or: [{ retailPrice: 0 }, { retailPrice: { $exists: false } }] },
    { $set: { retailPrice: 999 } }
  );
  console.log('Update Result:', result);

  process.exit(0);
}

checkProducts();
