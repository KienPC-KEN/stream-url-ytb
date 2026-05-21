const express = require("express");
const cors = require("cors");

const searchRouter = require("./src/routes/search");
const streamRouter = require("./src/routes/stream");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

app.use("/music/search", searchRouter);
app.use("/music/stream", streamRouter);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));