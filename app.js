require('dotenv').config()
const express = require("express");
const faceapi = require("face-api.js");
const mongoose = require("mongoose");
const { Canvas, Image } = require("canvas");
const canvas = require("canvas");
const fileUpload = require("express-fileupload");
const moment = require("moment-timezone");
moment.tz.setDefault("Asia/Manila");
const axios = require("axios")

const { getTimeDiff } = require("time-difference-js");

const ObjectId = require('mongoose').Types.ObjectId;
const db = require("./db");

faceapi.env.monkeyPatch({ Canvas, Image });

const cors = require("cors")
const app = express();

app.use(
  fileUpload({
    useTempFiles: true,
  })
);

app.use(express.json({ limit: '100mb' }));
app.use(cors({ origin: "*" }))

const server = require('http').createServer(app);
const io = require('socket.io')(server, {
  maxHttpBufferSize: 10e8,
  cors: {
    origin: "*",
    //credentials: true, //access-control-allow-credentials:true
    //optionSuccessStatus: 200,
    methods: ["GET", "POST", "UPDATE"]
  }
});

io.on("connection", socket => {
  console.log("New client connected " + socket.id);

  //call it from rpi
  socket.on("sms_sent", data => {
    const { } = data
    console.log("sms-sent")
  });

  socket.on("disconnect", () => {
    console.log("user disconnected");
  });

});

async function LoadModels() {
  // Load the models
  // __dirname gives the root directory of the server
  await faceapi.nets.faceRecognitionNet.loadFromDisk(__dirname + "/models");
  await faceapi.nets.faceLandmark68Net.loadFromDisk(__dirname + "/models");
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(__dirname + "/models");
}
LoadModels();

async function uploadLabeledImages(images) {
  try {
    //let counter = 0;
    const descriptions = [];
    // Loop through the images
    for (let i = 0; i < images.length; i++) {
      const img = await canvas.loadImage(images[i]);
      //counter = (i / images.length) * 100;
      //console.log(`Progress = ${counter}%`);
      // Read each face and save the face descriptions in the descriptions array
      const detections = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
      descriptions.push(detections.descriptor);
    }

    // Create a new face document with the given name and save it in DB

    return descriptions
  } catch (error) {
    console.log(error);
    return []
  }
}

async function getDescriptorsFromDB(student_id, image) {
  // Get all the face data from mongodb and loop through each of them to read the data
  let faces = await db.students.find({ _id: student_id }).select("_id name descriptions").lean();
  //console.log(faces)
  for (i = 0; i < faces.length; i++) {
    // Change the face data descriptors from Objects to Float32Array type
    for (j = 0; j < faces[i].descriptions.length; j++) {
      faces[i].descriptions[j] = new Float32Array(Object.values(faces[i].descriptions[j]));
    }
    // Turn the DB face docs to
    faces[i] = new faceapi.LabeledFaceDescriptors(faces[i]._id.toString(), faces[i].descriptions);
  }

  // Load face matcher to find the matching face
  const faceMatcher = new faceapi.FaceMatcher(faces, 0.6);

  // Read the image using canvas or other method
  const img = await canvas.loadImage(image);
  let temp = faceapi.createCanvasFromMedia(img);
  // Process the image for the model
  const displaySize = { width: img.width, height: img.height };
  faceapi.matchDimensions(temp, displaySize);

  // Find matching faces
  const detections = await faceapi.detectAllFaces(img).withFaceLandmarks().withFaceDescriptors();
  const resizedDetections = faceapi.resizeResults(detections, displaySize);
  const results = resizedDetections.map((d) => faceMatcher.findBestMatch(d.descriptor));
  return results;
}

async function SendSMS(to, msg) {
  try {
    const data = {
      to: to, msg: msg
    }
    io.sockets.emit("send_sms", data)
    return true
  } catch (error) {
    io.sockets.emit("send_sms", null)
    return false
  }
}

app.post("/test-sms", async (req, res) => {
  try {
    const val = req.body
    const to = val.to
    const msg = val.msg
    SendSMS(to, msg)
    res.status(200).json({ result: val })
  } catch (err) {
    console.log(err.message)
    res.status(500)
  }
})

app.post("/login", async (req, res) => {
  try {
    const val = req.body
    console.log(val)
    const username = val.username
    const password = val.password
    const col = val.col
    console.log(col)
    let user = await db[col].find({ username: username, password: password })
    console.log(user)
    if (user.length > 0) {
      res.status(200).json({ login: true, msg: "Successfuly Login", user: user[0] })
    } else {
      res.status(201).json({ login: false, msg: "Invalid username!", user: null })
    }
  } catch (err) {
    console.log(err.message)
    res.status(500)
  }
})

app.post("/add-student", async (req, res) => {
  try {
    const File = req.files.File.tempFilePath
    const val = JSON.parse(req.body.body)
    let result = await uploadLabeledImages([File])
    if (result.length !== 0) {
      //save to database
      val.descriptions = result
      const data = new db.students(val)
      const n = await data.save()
      console.log(n)
      res.json({ msg: "Student Successfully Added", isAdded: true })
    } else {
      res.json({ msg: "Unable to detect face, please try another image!", isAdded: false })

    }
  } catch (err) {
    console.log(err.message)
    res.status(500).json({ err: "Unable to detect face, please try another image!", isAdded: false })
  }
})

app.post("/update-student", async (req, res) => {
  try {
    const val = JSON.parse(req.body.body)
    console.log(val)
    if (val.updateImage === true) {
      const File = req.files.File.tempFilePath
      let result = await uploadLabeledImages([File])
      if (result.length !== 0) {
        //save to database
        val.descriptions = result
        const udata = await db.students.updateOne({ _id: val._id }, val)
        console.log(udata)
        res.status(200).json({ updated: udata.ok === 1 && udata.nModified >= 1 ? true : false })
      } else {
        res.json({ msg: "Something went wrong, please try again.", updated: false })
      }

    } else {
      const udata = await db.students.updateOne({ _id: val._id }, val)
      console.log(udata)
      res.status(200).json({ updated: udata.ok === 1 && udata.nModified >= 1 ? true : false })
    }

  } catch (err) {
    console.log(err.message)
    res.status(500).json({ err: err.message, isAdded: false })
  }
})

function reExtract(str, lmt) {
  if (str.length >= lmt) {
    return `${str.substr(0, lmt)}...`;
  }
  else {
    return str;
  }
}

function checkNumber(str) {
  let rxMatchNonDigits = /[^\d]+/g;
  // Remove all non-digits
  str = str.replace(rxMatchNonDigits, "");
  if (str.length >= 10) {
    return str
  } else {
    return null;
  }
}

app.post("/attendance-check", async (req, res) => {
  try {
    const File = req.files.File.tempFilePath;
    const val = JSON.parse(req.body.val)

    const student = val.student
    const student_id = student._id
    const teacher_id = val.teacher_id
    const subject = val.subject
    const class_schedule_id = val.class_schedule_id
    const class_schedule_time = val.class_schedule_time
    const what = val.what
    const today = moment().format("MM/DD/YYYY")
    console.log(today)
    console.log(class_schedule_time)
    const s = `${today} ${class_schedule_time}`
    console.log(s)
    console.log(moment(s).format("MM/DD/YYYY hh:mm:ss a"))
    const startTime = new Date(s);
    const endTime = new Date(moment().format("MM/DD/YYYY hh:mm:ss a"))

    const dur = getTimeDiff(startTime, endTime);
    console.log(dur)
    //dur.suffix!=="minutes"
    if (dur.suffix !== "minutes") {
      res.status(200).json({ msg: `Unable to attend! Class schedule has passed around ${dur.value} ${dur.suffix}` })
    } else {
      const duration = dur.value
      const time = moment().format("MMM-DD-YYYY @ hh:mm:ss A")
      console.log(time)
      //set remarks
      const remarks = duration > 30 ? `${duration} minutes LATE` : "PRESENT"
      console.log(remarks)
      let result = await getDescriptorsFromDB(student_id, File);
      if (result.length !== 0) {
        const rslt = result[0]
        const _id = rslt._label
        let msg
        //identify if attending student is just borrowing for attendance
        if (_id === 'unknown') {
          res.status(200).json({ msg: "Unregistered face detected!" })
        } else {
          if (_id !== student_id) {
            res.status(200).json({ msg: "Face detected is not recognized! Please try again." })
          } else {
            msg = `Successfully Participated!`
            const conf = (rslt._distance * 100) + 55

            const cp_number = checkNumber(student.parent_contact)
            const sms_content = `SJIT ALERT ${reExtract(student.name, 20)} participated class of ${reExtract(subject, 15)} dated ${time}!`

            const notified = cp_number !== null ? SendSMS(cp_number, sms_content) : false
            const data = new db.attendance({
              what: what,
              time: time,
              student: student._id,
              teacher: teacher_id,
              class_schedule: class_schedule_id,
              remarks: remarks
            })
            await data.save()



            //send sms notif
            res.json({ notified: notified, msg: msg, name: student.name, time: time, remark: remarks, confidence: conf !== 0 && conf < 100 ? `${(conf).toFixed(2)}%` : "99.9%" });
          }

        }
      } else {
        res.status(200).json({ msg: "Unable to detect or recognized face! Please try again." })
      }
    }
  } catch (err) {
    console.log(err.message)
    res.status(500)
  }
});

app.post("/get-enrolled-students", async (req, res) => {
  try {
    const val = req.body
    const query = val.query
    const join = val.join
    const select = val.select

    const result = await db.enrolled.find(query).select(select).populate(join)
    var list = []
    if (result.length > 0) {
      for (let i = 0; i < result.length; i++) {
        const v = result[i]
        var stud = v.student
        list.push({ _id: stud._id, std_id: stud.std_id, name: stud.name, birthdate: stud.birthdate })
      }
    }
    res.status(200).json({ result: list })
  } catch (err) {
    console.log(err.message)
    res.status(500)
  }
})

app.post("/get-attendance-report", async (req, res) => {
  try {
      const val = req.body
      const query = val.query
      const join = val.join
      const select = val.select
      var date = moment(val.date)
      date = date.add(1, "days")
      date = moment(date).format("MM-DD-YYYY")
      const dateF = moment(val.date).format("MM-DD-YYYY")
      const qS = [
          {
              $match: {
                  $and: [
                      { "createdAt": { $gte: new Date(dateF) } },
                      { "createdAt": { $lte: new Date(date) } },
                  ],
                  class_scheduleId: val.csID
              },
          }
      ]
      const rslt = await db.attendance.aggregate(qS)
      let result = await db.attendance.populate(rslt, { path: join !== undefined ? join : "", select: select })
      var l = []
      var s = {}
      if (result.length > 0) {
          console.log('before', result.length)
          result = await removeDuplicates(result, ['class_scheduleId', 'teacherId', 'studentId', 'time'])
          console.log('after', result.length)
          for (let i = 0; i < result.length; i++) {
              const v = result[i]
              s = {
                  subject: v.class_schedule.subject,
                  teacher: v.teacher.name,
                  date: moment(v.time).format("MM-DD-YYYY"),
                  schedule_date: v.class_schedule.days.join(" "),
                  schedule_time: `${moment(v.class_schedule.time[0]).format("hh:mm A")} - ${moment(v.class_schedule.time[1]).format("hh:mm A")}`,
              }

              l.push({
                  _id: v.student._id.toString(),
                  student_id: v.student.std_id,
                  student: v.student.name,
                  date: moment(v.time).format("MM-DD-YYYY"), timeIn: moment(v.time).format("hh:mm:ss A"),
                  remarks: v.remarks
              })


          }

      }
      let enrolledStudents = await db.enrolled.find({ class_scheduleId: val.csID }).select('').populate('student').lean()
      console.log(enrolledStudents.length)
      
      let data = [...l]
      if (enrolledStudents.length > 0) {
          console.log('before', enrolledStudents.length)
          enrolledStudents = await removeDuplicates(enrolledStudents, ['class_scheduleId', 'studentId', 'teacherId'])
          console.log('after', enrolledStudents.length)
          for(let i=0; i<enrolledStudents.length; i++){
              const eS = enrolledStudents[i]
              const eSID = eS.student._id.toString()
              console.log(l.some(obj => obj._id.toString() === eSID))
              if(!l.some(obj => obj._id.toString() === eSID)){
                  data.push({
                      _id: eS.student._id.toString(),
                      student_id: eS.student.std_id,
                      student: eS.student.name,
                      date: '-----------',
                      timeIn: '-----------',
                      remarks: 'ABSENT'
                    })
              }
          }
      } 
      const present = data.filter(({ remarks }) => remarks === "PRESENT")
      const late = data.filter(({ remarks }) => remarks.toLowerCase().includes("late"))
      const absent = data.filter(({ remarks }) => remarks === "ABSENT")

      const calcPerc = (part) => {
          const perc = ((part / enrolledStudents.length) * 100).toFixed(0)
          return `${isNaN(perc) ? '' : perc + '%'}` 
      }

      const summary = Object.assign(s, {
          totalStudents: enrolledStudents.length,
          present: present.length,
          presentPercentage: calcPerc(present.length),
          late: late.length,
          latePercentage: calcPerc(late.length),
          absent: absent.length,
          absentPercentage: calcPerc(absent.length),
      })
      console.log(data.length)
      res.json({ summary: summary, result: data })
  } catch (err) {
      console.log(err.message)
      res.status(500)
  }
})

app.post("/get", async (req, res) => {
  try {
    const val = req.body
    const col = val.col
    const select = val.select
    const query = val.query
    const join = val.join
    var rslt = await db[col].find(query).select(select)
    const result = await db[col].populate(rslt, { path: join !== undefined ? join : "" })
    res.status(200).json({ result: result })
  } catch (err) {
    console.log(err.message)
    res.status(500)
  }
})

app.post("/get-student-image", async (req, res) => {
  try {
    const val = req.body
    const result = await db.students.find({ _id: val._id }).select("-_id image")
    console.log(result)
    res.json({ image: result[0].image })
  } catch (err) {
    console.log(err.message)
    res.json({ image: null })
  }
})

function isJSON(val) {
  try {
    return [true, JSON.parse(val)]
  } catch (err) {
    //console.log(err.message)
    return [false, null]
  }
}
app.post("/insert", async (req, res) => {
  try {
    const val = req.body
    //console.log(val)
    const col = val.col
    const data = val.data
    const nd = new db[col](data)
    const nnd = await nd.save()
    res.status(200).json({ inserted: nd === nnd, data: nnd })
  } catch (err) {
    console.log(err.message)
    res.status(500)
  }
})

app.post("/update", async (req, res) => {
  try {
    const val = req.body
    const col = val.col
    const data = val.data
    const query = val.query
    const udata = await db[col].updateOne(query, data)

    res.status(200).json({ updated: udata.ok === 1 && udata.nModified >= 1 ? true : false })
  } catch (err) {
    console.log(err.message)
    res.status(500)
  }
})

app.post("/remove", async (req, res) => {
  try {
    const val = req.body
    const col = val.col
    const _id = val._id
    const d = await db[col].deleteOne({ _id: _id })

    res.status(200).json({ deleted: true, data: d })
  } catch (err) {
    console.log(err.message)
    res.status(500)
  }
})

app.get("/", (_, res) => {
  res.status(200).json({ msg: "API is Running" })
})
mongoose
  .connect(
    `mongodb+srv://sjit:pass@cluster0.suax5r5.mongodb.net/sjit`,
    {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      useCreateIndex: true,
    }
  )
  .then(() => {
    const port = process.env.PORT || 5000
    server.listen(port || "0.0.0.0", () => console.log(`Server Started on PORT ${port}`))
    console.log("DB connected");
  })
  .catch((err) => {
    console.log(err);
  });
