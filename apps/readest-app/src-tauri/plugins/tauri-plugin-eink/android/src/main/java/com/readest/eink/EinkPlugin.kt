package com.readest.eink

import android.app.Activity
import android.util.Log
import android.view.View
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import kotlinx.coroutines.*
import java.lang.reflect.Method

@TauriPlugin
class EinkPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        private const val TAG = "EinkPlugin"
        private const val EPD_CONTROLLER_CLASS = "com.onyx.android.sdk.device.EpdController"
        private const val EPD_MODE_CLASS = "com.onyx.android.sdk.device.EpdController\$EPDMode"
        private const val UPDATE_MODE_CLASS = "com.onyx.android.sdk.device.EpdController\$UpdateMode"
    }

    private val pluginScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    
    @Volatile
    private var epdAvailable = false
    private var epdControllerClass: Class<*>? = null
    private var epdModeClass: Class<*>? = null
    private var updateModeClass: Class<*>? = null
    private var setModeMethod: Method? = null
    private var postInvalidateMethod: Method? = null
    private val supportedModes = mutableListOf<String>()

    init {
        initReflection()
    }

    @Suppress("TryWithIdenticalCatches")
    private fun initReflection() {
        try {
            epdControllerClass = Class.forName(EPD_CONTROLLER_CLASS)
            epdModeClass = Class.forName(EPD_MODE_CLASS)
            updateModeClass = Class.forName(UPDATE_MODE_CLASS)

            // Reflect EpdController.setMode(Context, EPDMode)
            // EpdController.setMode(Context context, EPDMode mode)
            for (method in epdControllerClass!!.declaredMethods) {
                when (method.name) {
                    "setMode" -> {
                        val paramTypes = method.parameterTypes
                        if (paramTypes.size == 2 && paramTypes[0] == android.content.Context::class.java) {
                            setModeMethod = method
                        }
                    }
                    "postInvalidate" -> {
                        val paramTypes = method.parameterTypes
                        if (paramTypes.size == 2 && paramTypes[0] == View::class.java) {
                            postInvalidateMethod = method
                        }
                    }
                }
            }

            // Extract available EPDMode values
            if (epdModeClass != null) {
                for (field in epdModeClass!!.declaredFields) {
                    if (field.isEnumConstant) {
                        supportedModes.add(field.name)
                    }
                }
            }

            epdAvailable = true
            Log.i(TAG, "Boox EPD controller detected via reflection")
        } catch (e: ClassNotFoundException) {
            Log.i(TAG, "Boox EPD controller not available (non-Boox device)")
            epdAvailable = false
        } catch (e: Exception) {
            Log.w(TAG, "Error initializing EPD reflection", e)
            epdAvailable = false
        }
    }

    override fun onDestroy() {
        pluginScope.cancel()
        super.onDestroy()
    }

    @Command
    fun get_epd_capabilities(invoke: Invoke) {
        val ret = JSObject()
        if (epdAvailable && epdControllerClass != null) {
            ret.put("available", true)
            val modesArr = com.readest.eink.JSArray()
            supportedModes.forEach { modesArr.put(it) }
            ret.put("modes", modesArr)
        } else {
            ret.put("available", false)
            ret.put("modes", com.readest.eink.JSArray())
        }
        invoke.resolve(ret)
    }

    @Command
    fun set_epd_mode(invoke: Invoke) {
        val args = invoke.parseArgs(SetEpdModeArgs::class.java)
        if (!epdAvailable || setModeMethod == null) {
            invoke.resolve(JSObject().apply { put("success", false); put("error", "EPD not available") })
            return
        }
        pluginScope.launch {
            try {
                val modeArg = args.mode?.uppercase() ?: "AUTO"
                withContext(Dispatchers.Main) {
                    val enumValue = epdModeClass?.declaredFields
                        ?.firstOrNull { it.name == modeArg }
                        ?.get(null)
                    if (enumValue != null) {
                        setModeMethod?.invoke(null, activity, enumValue)
                        invoke.resolve(JSObject().apply { put("success", true) })
                    } else {
                        invoke.resolve(JSObject().apply { put("success", false); put("error", "Unknown mode: $modeArg") })
                    }
                }
            } catch (e: Exception) {
                invoke.resolve(JSObject().apply { put("success", false); put("error", e.message) })
            }
        }
    }

    @Command
    fun do_epd_refresh(invoke: Invoke) {
        if (!epdAvailable || postInvalidateMethod == null) {
            invoke.resolve(JSObject().apply { put("success", false); put("error", "EPD not available") })
            return
        }
        pluginScope.launch {
            try {
                withContext(Dispatchers.Main) {
                    // Use GC (Grayscale Clear 16) mode for full refresh
                    val gcMode = updateModeClass?.declaredFields?.firstOrNull { it.name == "GC" }?.get(null)
                    val decorView = activity.window.decorView
                    postInvalidateMethod?.invoke(null, decorView, gcMode)
                    invoke.resolve(JSObject().apply { put("success", true) })
                }
            } catch (e: Exception) {
                invoke.resolve(JSObject().apply { put("success", false); put("error", e.message) })
            }
        }
    }
}

/** Args for set_epd_mode */
class SetEpdModeArgs {
    var mode: String? = null
}
