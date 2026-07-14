const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const Stripe = require("stripe");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const verifyToken = require("./middleware/verifyToken");
const verifyRole = require("./middleware/verifyRole");

const app = express();
const port = process.env.PORT || 5000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ---------- Middleware ----------
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      process.env.CLIENT_URL,
    ],
    credentials: true,
  })
);
app.use(express.json());

// ---------- MongoDB ----------
const uri = process.env.DB_URI;

if (!uri) {
  console.error("Missing DB_URI in .env — paste the full connection string from MongoDB Atlas's Connect button.");
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db(process.env.DB_NAME);
    const userCollection = db.collection("users");
    const campaignCollection = db.collection("campaigns");
    const contributionCollection = db.collection("contributions");
    const withdrawalCollection = db.collection("withdrawals");
    const paymentCollection = db.collection("payments");
    const notificationCollection = db.collection("notifications");
    const reportCollection = db.collection("reports");

    // ---------- Role middleware shortcuts ----------
    const verifySupporter = verifyRole(userCollection, ["Supporter"]);
    const verifyCreator = verifyRole(userCollection, ["Creator"]);
    const verifyAdmin = verifyRole(userCollection, ["Admin"]);
    const verifyCreatorOrAdmin = verifyRole(userCollection, ["Creator", "Admin"]);

    // ---------- Helper: create a notification ----------
    const createNotification = async ({ message, toEmail, actionRoute }) => {
      await notificationCollection.insertOne({
        message,
        toEmail,
        actionRoute,
        time: new Date(),
        read: false,
      });
    };

    // =========================================================
    // JWT
    // =========================================================
    app.post("/jwt", (req, res) => {
      const { email } = req.body;
      const token = jwt.sign({ email }, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "7d",
      });
      res.send({ token });
    });

    // =========================================================
    // USERS
    // =========================================================

    // Register a new user (called right after Firebase signup)
    app.post("/users", async (req, res) => {
      const user = req.body;
      const existing = await userCollection.findOne({ email: user.email });
      if (existing) {
        return res.send({ message: "user already exists", inserted: false });
      }

      // Assign starting credits exactly once, based on role
      const startingCredits = user.role === "Creator" ? 20 : 50;

      const newUser = {
        name: user.name,
        email: user.email,
        photoURL: user.photoURL || "",
        role: user.role === "Creator" ? "Creator" : "Supporter",
        credits: startingCredits,
        created_at: new Date(),
      };

      const result = await userCollection.insertOne(newUser);
      res.send(result);
    });

    // Get all users - Admin only (Manage Users)
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const users = await userCollection.find().sort({ created_at: -1 }).toArray();
      res.send(users);
    });

    // Get a user's role (used by useRole hook on the client)
    app.get("/users/role/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const user = await userCollection.findOne({ email });
      res.send({ role: user?.role || null });
    });

    // Get single user profile (credits, name, photo etc.)
    app.get("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const user = await userCollection.findOne({ email });
      res.send(user);
    });

    // Update a user's role - Admin only
    app.patch("/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      const result = await userCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } }
      );
      res.send(result);
    });

    // Remove a user - Admin only
    app.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await userCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // =========================================================
    // CAMPAIGNS
    // =========================================================

    // Add a new campaign - Creator only, status starts as "pending"
    app.post("/campaigns", verifyToken, verifyCreator, async (req, res) => {
      const campaign = req.body;
      campaign.status = "pending";
      campaign.amount_raised = 0;
      campaign.funding_goal = Number(campaign.funding_goal);
      campaign.minimum_contribution = Number(campaign.minimum_contribution);
      campaign.deadline = new Date(campaign.deadline);
      campaign.created_at = new Date();
      const result = await campaignCollection.insertOne(campaign);
      res.send(result);
    });

    // Public: get approved campaigns whose deadline hasn't passed (Explore Campaigns)
    app.get("/campaigns", async (req, res) => {
      const { search, category } = req.query;
      const query = {
        status: "approved",
        deadline: { $gte: new Date() },
      };
      if (category && category !== "all") query.category = category;
      if (search) query.campaign_title = { $regex: search, $options: "i" };

      const campaigns = await campaignCollection.find(query).sort({ deadline: 1 }).toArray();
      res.send(campaigns);
    });

    // Public: Top 6 funded campaigns for the homepage
    app.get("/campaigns/top-funded", async (req, res) => {
      const campaigns = await campaignCollection
        .find({ status: "approved" })
        .sort({ amount_raised: -1 })
        .limit(6)
        .toArray();
      res.send(campaigns);
    });

    // Admin: campaigns pending approval
    app.get("/campaigns/pending", verifyToken, verifyAdmin, async (req, res) => {
      const campaigns = await campaignCollection.find({ status: "pending" }).toArray();
      res.send(campaigns);
    });

    // Admin: every campaign, any status (Manage Campaigns)
    app.get("/campaigns/all", verifyToken, verifyAdmin, async (req, res) => {
      const campaigns = await campaignCollection.find().sort({ created_at: -1 }).toArray();
      res.send(campaigns);
    });

    // Creator: their own campaigns, newest deadline first
    app.get("/campaigns/creator/:email", verifyToken, verifyCreator, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const campaigns = await campaignCollection
        .find({ creator_email: email })
        .sort({ deadline: -1 })
        .toArray();
      res.send(campaigns);
    });

    // Public: single campaign details
    app.get("/campaigns/:id", async (req, res) => {
      const id = req.params.id;
      const campaign = await campaignCollection.findOne({ _id: new ObjectId(id) });
      res.send(campaign);
    });

    // Creator: update title / story / reward_info only
    app.patch("/campaigns/:id", verifyToken, verifyCreator, async (req, res) => {
      const id = req.params.id;
      const { campaign_title, campaign_story, reward_info } = req.body;
      const result = await campaignCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { campaign_title, campaign_story, reward_info } }
      );
      res.send(result);
    });

    // Admin: approve / reject a campaign
    app.patch("/campaigns/status/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body; // "approved" | "rejected"
      const campaign = await campaignCollection.findOne({ _id: new ObjectId(id) });
      const result = await campaignCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );

      await createNotification({
        message: `Your campaign "${campaign.campaign_title}" was ${status} by the admin`,
        toEmail: campaign.creator_email,
        actionRoute: "/dashboard/my-campaigns",
      });

      res.send(result);
    });

    // Creator: delete a campaign + refund every approved supporter
    app.delete("/campaigns/:id", verifyToken, verifyCreator, async (req, res) => {
      const id = req.params.id;
      const approvedContributions = await contributionCollection
        .find({ campaign_id: id, status: "approved" })
        .toArray();

      for (const c of approvedContributions) {
        await userCollection.updateOne(
          { email: c.supporter_email },
          { $inc: { credits: c.contribution_amount } }
        );
      }

      const result = await campaignCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // Admin: delete any campaign directly
    app.delete("/campaigns/admin/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await campaignCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // Creator: home stats (total campaigns, active campaigns, total raised)
    app.get("/creator-stats/:email", verifyToken, verifyCreator, async (req, res) => {
      const email = req.params.email;
      const campaigns = await campaignCollection.find({ creator_email: email }).toArray();
      const totalCampaigns = campaigns.length;
      const activeCampaigns = campaigns.filter((c) => new Date(c.deadline) >= new Date()).length;
      const totalRaised = campaigns.reduce((sum, c) => sum + (c.amount_raised || 0), 0);
      res.send({ totalCampaigns, activeCampaigns, totalRaised });
    });

    // =========================================================
    // CONTRIBUTIONS
    // =========================================================

    // Supporter: make a new contribution -> credits are held immediately
    app.post("/contributions", verifyToken, verifySupporter, async (req, res) => {
      const contribution = req.body;
      const supporter = await userCollection.findOne({ email: contribution.supporter_email });

      if (!supporter || supporter.credits < contribution.contribution_amount) {
        return res.status(400).send({ message: "insufficient credits" });
      }

      contribution.contribution_amount = Number(contribution.contribution_amount);
      contribution.status = "pending";
      contribution.current_date = new Date();

      const result = await contributionCollection.insertOne(contribution);

      // hold the credits until the creator approves/rejects
      await userCollection.updateOne(
        { email: contribution.supporter_email },
        { $inc: { credits: -contribution.contribution_amount } }
      );

      await createNotification({
        message: `${contribution.supporter_name} contributed ${contribution.contribution_amount} credits to ${contribution.campaign_title}`,
        toEmail: contribution.creator_email,
        actionRoute: "/dashboard/creator-home",
      });

      res.send(result);
    });

    // Creator: pending contributions for their campaigns
    app.get("/contributions/pending/:email", verifyToken, verifyCreator, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const contributions = await contributionCollection
        .find({ creator_email: email, status: "pending" })
        .toArray();
      res.send(contributions);
    });

    // Supporter: approved contributions (Approved Contributions table)
    app.get("/contributions/approved/:email", verifyToken, verifySupporter, async (req, res) => {
      const email = req.params.email;
      const contributions = await contributionCollection
        .find({ supporter_email: email, status: "approved" })
        .toArray();
      res.send(contributions);
    });

    // Supporter: all contributions, paginated (My Contributions page)
    app.get("/contributions/supporter/:email", verifyToken, verifySupporter, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const page = parseInt(req.query.page) || 0;
      const limit = parseInt(req.query.limit) || 5;

      const total = await contributionCollection.countDocuments({ supporter_email: email });
      const contributions = await contributionCollection
        .find({ supporter_email: email })
        .sort({ current_date: -1 })
        .skip(page * limit)
        .limit(limit)
        .toArray();

      res.send({ contributions, total });
    });

    // Supporter: home stats
    app.get("/contributions/stats/:email", verifyToken, verifySupporter, async (req, res) => {
      const email = req.params.email;
      const all = await contributionCollection.find({ supporter_email: email }).toArray();
      const totalContributions = all.length;
      const totalPending = all.filter((c) => c.status === "pending").length;
      const totalAmount = all
        .filter((c) => c.status === "approved")
        .reduce((sum, c) => sum + c.contribution_amount, 0);
      res.send({ totalContributions, totalPending, totalAmount });
    });

    // Creator: approve or reject a contribution
    app.patch("/contributions/status/:id", verifyToken, verifyCreator, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body; // "approved" | "rejected"

      const contribution = await contributionCollection.findOne({ _id: new ObjectId(id) });
      if (!contribution) return res.status(404).send({ message: "not found" });

      await contributionCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );

      if (status === "approved") {
        await campaignCollection.updateOne(
          { _id: new ObjectId(contribution.campaign_id) },
          { $inc: { amount_raised: contribution.contribution_amount } }
        );
      } else if (status === "rejected") {
        // refund the held credits back to the supporter
        await userCollection.updateOne(
          { email: contribution.supporter_email },
          { $inc: { credits: contribution.contribution_amount } }
        );
      }

      await createNotification({
        message: `Your contribution of ${contribution.contribution_amount} credits to ${contribution.campaign_title} was ${status} by ${contribution.creator_name}`,
        toEmail: contribution.supporter_email,
        actionRoute: "/dashboard/supporter-home",
      });

      res.send({ message: `contribution ${status}` });
    });

    // =========================================================
    // WITHDRAWALS
    // =========================================================

    // Creator: request a withdrawal
    app.post("/withdrawals", verifyToken, verifyCreator, async (req, res) => {
      const withdrawal = req.body;

      const campaigns = await campaignCollection.find({ creator_email: withdrawal.creator_email }).toArray();
      const totalRaised = campaigns.reduce((sum, c) => sum + (c.amount_raised || 0), 0);

      if (totalRaised < 200) {
        return res.status(400).send({ message: "minimum 200 credits raised required to withdraw" });
      }
      if (withdrawal.withdrawal_credit > totalRaised) {
        return res.status(400).send({ message: "cannot withdraw more than total raised credits" });
      }

      withdrawal.withdrawal_credit = Number(withdrawal.withdrawal_credit);
      withdrawal.withdrawal_amount = Number(withdrawal.withdrawal_amount);
      withdrawal.status = "pending";
      withdrawal.withdraw_date = new Date();

      const result = await withdrawalCollection.insertOne(withdrawal);
      res.send(result);
    });

    // Admin: pending withdrawal requests
    app.get("/withdrawals/pending", verifyToken, verifyAdmin, async (req, res) => {
      const withdrawals = await withdrawalCollection.find({ status: "pending" }).toArray();
      res.send(withdrawals);
    });

    // Creator: their withdrawal / payment history
    app.get("/withdrawals/creator/:email", verifyToken, verifyCreator, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const withdrawals = await withdrawalCollection
        .find({ creator_email: email })
        .sort({ withdraw_date: -1 })
        .toArray();
      res.send(withdrawals);
    });

    // Admin: mark a withdrawal as paid
    app.patch("/withdrawals/approve/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const withdrawal = await withdrawalCollection.findOne({ _id: new ObjectId(id) });
      if (!withdrawal) return res.status(404).send({ message: "not found" });

      await withdrawalCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } }
      );

      // decrease the creator's raised credits across their campaigns (oldest first)
      let remaining = withdrawal.withdrawal_credit;
      const campaigns = await campaignCollection
        .find({ creator_email: withdrawal.creator_email, amount_raised: { $gt: 0 } })
        .sort({ created_at: 1 })
        .toArray();

      for (const c of campaigns) {
        if (remaining <= 0) break;
        const deduct = Math.min(c.amount_raised, remaining);
        await campaignCollection.updateOne(
          { _id: c._id },
          { $inc: { amount_raised: -deduct } }
        );
        remaining -= deduct;
      }

      await createNotification({
        message: `Your withdrawal request of ${withdrawal.withdrawal_credit} credits ($${withdrawal.withdrawal_amount}) has been approved`,
        toEmail: withdrawal.creator_email,
        actionRoute: "/dashboard/payment-history",
      });

      res.send({ message: "withdrawal approved" });
    });

    // =========================================================
    // PAYMENTS (Stripe - credit purchase)
    // =========================================================

    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const { price } = req.body; // price in dollars
      const amount = Math.round(price * 100);

      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({ clientSecret: paymentIntent.client_secret });
    });

    // Save a successful payment + top up the supporter's credits
    app.post("/payments", verifyToken, verifySupporter, async (req, res) => {
      const payment = req.body;
      payment.date = new Date();

      const result = await paymentCollection.insertOne(payment);

      await userCollection.updateOne(
        { email: payment.email },
        { $inc: { credits: payment.credits } }
      );

      res.send(result);
    });

    // Supporter: payment history
    app.get("/payments/supporter/:email", verifyToken, verifySupporter, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const payments = await paymentCollection.find({ email }).sort({ date: -1 }).toArray();
      res.send(payments);
    });

    // =========================================================
    // NOTIFICATIONS
    // =========================================================

    app.get("/notifications/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const notifications = await notificationCollection
        .find({ toEmail: email })
        .sort({ time: -1 })
        .toArray();
      res.send(notifications);
    });

    // =========================================================
    // REPORTS
    // =========================================================

    // Supporter: report a suspicious/fraudulent campaign
    app.post("/reports", verifyToken, verifySupporter, async (req, res) => {
      const report = req.body;
      report.date = new Date();
      report.status = "open";
      const result = await reportCollection.insertOne(report);
      res.send(result);
    });

    // Admin: all reports
    app.get("/reports", verifyToken, verifyAdmin, async (req, res) => {
      const reports = await reportCollection.find().sort({ date: -1 }).toArray();
      res.send(reports);
    });

    // Admin: suspend the reported campaign
    app.patch("/reports/suspend/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const report = await reportCollection.findOne({ _id: new ObjectId(id) });
      await campaignCollection.updateOne(
        { _id: new ObjectId(report.campaign_id) },
        { $set: { status: "suspended" } }
      );
      const result = await reportCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "resolved" } }
      );
      res.send(result);
    });

    // Admin: delete the reported campaign entirely
    app.delete("/reports/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const report = await reportCollection.findOne({ _id: new ObjectId(id) });
      if (report?.campaign_id) {
        await campaignCollection.deleteOne({ _id: new ObjectId(report.campaign_id) });
      }
      const result = await reportCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // =========================================================
    // ADMIN STATS
    // =========================================================
    app.get("/admin-stats", verifyToken, verifyAdmin, async (req, res) => {
      const totalSupporters = await userCollection.countDocuments({ role: "Supporter" });
      const totalCreators = await userCollection.countDocuments({ role: "Creator" });
      const users = await userCollection.find().toArray();
      const totalCredits = users.reduce((sum, u) => sum + (u.credits || 0), 0);
      const totalPayments = await paymentCollection.countDocuments();
      res.send({ totalSupporters, totalCreators, totalCredits, totalPayments });
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB successfully!");
  } finally {
    // keep the connection alive while the server runs
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("CrowdSpark server is running");
});

app.listen(port, () => {
  console.log(`CrowdSpark server listening on port ${port}`);
});
