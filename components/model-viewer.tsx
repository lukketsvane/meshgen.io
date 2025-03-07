"use client"

import { Suspense, useState, useEffect, useRef, useCallback } from "react"
import { Canvas, useThree } from "@react-three/fiber"
import { OrbitControls, Html } from "@react-three/drei"
import { GLTFLoader } from "three-stdlib"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Layers, Download, Save, Loader2, Expand, X, FolderPlus } from "lucide-react"
import * as THREE from "three"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { saveModelToDatabase, saveModelToProject, getProjects, checkModelExists, createProject } from "@/app/actions"
import { toast } from "sonner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Project } from "@/types/database"
import { ProjectDialog } from "@/components/project-dialog"

interface LightState {
  position: [number, number, number]
  intensity: number
  temperature: number
}

const INITIAL_LIGHT_STATE: LightState = {
  position: [2, 2, 2],
  intensity: 1,
  temperature: 6500,
}

function ModelLoader({
  url,
  onLoad,
  onError,
}: {
  url: string
  onLoad: (scene: THREE.Group) => void
  onError: (error: string) => void
}) {
  const [retryCount, setRetryCount] = useState(0)
  const [model, setModel] = useState<THREE.Group | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const maxRetries = 3

  useEffect(() => {
    let canceled = false
    const loader = new GLTFLoader()
    loader.load(
      url,
      (gltf) => {
        if (!canceled) {
          setModel(gltf.scene)
          onLoad(gltf.scene)
        }
      },
      undefined,
      (err) => {
        if (!canceled) {
          if (retryCount < maxRetries) {
            const timer = setTimeout(() => setRetryCount((prev) => prev + 1), 1000 * retryCount)
            return () => clearTimeout(timer)
          } else {
            const message = err instanceof Error ? err.message : "Failed to load model"
            setModelError(message)
            onError(message)
          }
        }
      }
    )
    return () => { canceled = true }
  }, [url, retryCount, onLoad, onError, maxRetries])

  if (modelError) {
    return (
      <Html center>
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-6 w-6 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">{modelError}</div>
        </div>
      </Html>
    )
  }

  if (!model) {
    return (
      <Html center>
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            {retryCount < maxRetries
              ? `Loading model${retryCount > 0 ? ` (Attempt ${retryCount + 1})` : ""}`
              : "Failed to load model"}
          </div>
        </div>
      </Html>
    )
  }
  return null
}

function ModelContent({
  url,
  onError,
}: {
  url: string
  onError: (error: string) => void
}) {
  const [model, setModel] = useState<THREE.Group | null>(null)
  const materials = useRef(new Map<THREE.Mesh, THREE.Material | THREE.Material[]>())
  const matteMaterial = useRef(
    new THREE.MeshStandardMaterial({
      color: 0xffffff, 
      roughness: 0.8,  
      metalness: 0.0,
    })
  )
  const { scene: threeScene } = useThree()

  const handleModelLoad = useCallback(
    (loadedScene: THREE.Group) => {
      try {
        loadedScene.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            materials.current.set(obj, obj.material)
            obj.material = matteMaterial.current
            obj.castShadow = true
            obj.receiveShadow = true
          }
        })
        const box = new THREE.Box3().setFromObject(loadedScene)
        const offsetY = -box.min.y
        loadedScene.position.y += offsetY
        setModel(loadedScene)
      } catch (err) {
        console.error("Model setup error:", err)
        onError("Failed to setup model materials")
      }
    },
    [onError]
  )

  useEffect(() => {
    return () => {
      if (model) {
        model.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            if (obj.geometry) obj.geometry.dispose()
            const material = materials.current.get(obj)
            if (Array.isArray(material)) material.forEach((m) => m.dispose())
            else if (material) material.dispose()
          }
        })
        setModel(null)
      }
    }
  }, [url, model])

  const toggleTextures = useCallback(() => {
    if (!model) return
    model.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.material =
          obj.material === matteMaterial.current
            ? materials.current.get(obj) || obj.material
            : matteMaterial.current
      }
    })
  }, [model])

  useEffect(() => {
    if (threeScene) {
      threeScene.userData.toggleTextures = toggleTextures
    }
  }, [threeScene, toggleTextures])

  return (
    <>
      {model ? (
        <primitive object={model} scale={1} />
      ) : (
        <ModelLoader url={url} onLoad={handleModelLoad} onError={onError} />
      )}
      <MovableLight />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[100, 100]} />
        <shadowMaterial transparent opacity={0.4} />
      </mesh>
      <OrbitControls
        makeDefault
        minDistance={2}
        maxDistance={10}
        onChange={(e) => {
          if (e && threeScene) {
            threeScene.userData.controls = e.target
          }
        }}
      />
    </>
  )
}

function MovableLight() {
  const [lightState, setLightState] = useState<LightState>(INITIAL_LIGHT_STATE)
  const isDragging = useRef(false)
  const isAdjusting = useRef(false)
  const prevPos = useRef({ x: 0, y: 0 })
  const { gl, scene } = useThree()
  const { theme } = useTheme()

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (!e.shiftKey) return
      e.preventDefault()
      if (e.altKey) {
        isAdjusting.current = true
      } else {
        isDragging.current = true
      }
      prevPos.current = { x: e.clientX, y: e.clientY }
      if (scene.userData.controls) scene.userData.controls.enabled = false
    }
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current && !isAdjusting.current) return
      const dx = e.clientX - prevPos.current.x
      const dy = e.clientY - prevPos.current.y
      const scaledDx = dx * 0.05
      const scaledDy = dy * 0.05
      setLightState((prev) => {
        if (isAdjusting.current) {
          const newTemp = Math.max(2000, Math.min(10000, prev.temperature + scaledDx * 100))
          const newInt = Math.max(0, Math.min(6, prev.intensity - scaledDy))
          return { ...prev, intensity: newInt, temperature: newTemp }
        } else {
          return {
            ...prev,
            position: [
              prev.position[0] + scaledDx,
              prev.position[1] - scaledDy,
              prev.position[2],
            ],
          }
        }
      })
      prevPos.current = { x: e.clientX, y: e.clientY }
    }
    const handleMouseUp = () => {
      isDragging.current = false
      isAdjusting.current = false
      if (scene.userData.controls) scene.userData.controls.enabled = true
    }
    gl.domElement.addEventListener("mousedown", handleMouseDown)
    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    return () => {
      gl.domElement.removeEventListener("mousedown", handleMouseDown)
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [gl, scene])
  
  const color = tempToColor(lightState.temperature)
  return (
    <>
      <directionalLight
        position={lightState.position}
        intensity={lightState.intensity}
        color={color}
        castShadow
      />
      <group position={lightState.position}>
        <mesh>
          <sphereGeometry args={[0.2, 16, 16]} />
          <meshBasicMaterial color={color} />
        </mesh>
        <line>
          <bufferGeometry>
            <float32BufferAttribute
              attach="attributes-position"
              array={new Float32Array([
                0, 0, 0,
                -lightState.position[0],
                -lightState.position[1],
                -lightState.position[2],
              ])}
              itemSize={3}
            />
          </bufferGeometry>
          <lineBasicMaterial color={theme === "dark" ? "#fff" : "#000"} />
        </line>
        <Html position={[0.3, 0.3, 0]} center>
          <div className="px-2 py-1 text-[10px] bg-background/80 backdrop-blur-sm rounded border">
            {lightState.intensity.toFixed(1)}x • {(lightState.temperature / 1000).toFixed(1)}K
          </div>
        </Html>
      </group>
    </>
  )
}

export function ModelViewer({
  url,
  inputImage,
  resolution,
  currentProjectId,
  onProjectSelect,
}: {
  url: string
  inputImage?: string
  resolution?: number
  currentProjectId?: string | null
  onProjectSelect?: (projectId: string) => void
}) {
  const { theme } = useTheme()
  const [state, setState] = useState({
    error: null as string | null,
    saving: false,
    saveSuccess: false,
  })
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(currentProjectId)
  const [isMobile, setIsMobile] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768)
    checkMobile()
    window.addEventListener("resize", checkMobile)
    return () => window.removeEventListener("resize", checkMobile)
  }, [])

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const projectsList = await getProjects()
        setProjects(projectsList)
      } catch (error) {
        console.error("Error fetching projects:", error)
      }
    }
    fetchProjects()
  }, [])

  const handleError = useCallback((error: string) => {
    setState((prev) => ({ ...prev, error }))
    toast.error(error)
  }, [])

  const bg = theme === "dark" ? "#000" : "#fff"

  const handleToggleTextures = () => {
    const canvas = document.querySelector("canvas") as any
    canvas?.__r3f?.scene?.userData.toggleTextures?.()
  }

  const handleProjectCreated = async (projectId: string, projectName: string) => {
    setSelectedProjectId(projectId)
    setProjects((prev) => [
      {
        id: projectId,
        name: projectName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      ...prev,
    ])
    toast.success(`Project "${projectName}" created`)

    if (onProjectSelect) {
      onProjectSelect(projectId)
    }
  }

  const handleSaveModel = async () => {
    if (!url || !inputImage || !resolution) return

    setState((prev) => ({ ...prev, saving: true, error: null }))

    try {
      const existsResult = await checkModelExists(url, selectedProjectId || null)

      if (existsResult.exists) {
        toast.info("This model is already saved")
        setState((prev) => ({
          ...prev,
          saving: false,
          saveSuccess: true,
        }))
        return
      }

      if (selectedProjectId) {
        const result = await saveModelToProject(
          selectedProjectId,
          url,
          inputImage,
          inputImage,
          resolution,
          `Model ${new Date().toLocaleString()}`
        )

        if (result) {
          setState((prev) => ({ ...prev, saveSuccess: true }))
          toast.success("Model saved to project successfully")

          if (onProjectSelect && selectedProjectId !== currentProjectId) {
            onProjectSelect(selectedProjectId)
          }
        } else {
          setState((prev) => ({
            ...prev,
            error: "Failed to save model to project",
          }))
          toast.error("Failed to save model to project")
        }
      } else {
        await saveModelToDatabase(url, inputImage, resolution)
        setState((prev) => ({ ...prev, saveSuccess: true }))
        toast.success("Model saved successfully")
      }
    } catch (err: any) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : "Save failed",
      }))
      toast.error("Failed to save model")
    } finally {
      setState((prev) => ({ ...prev, saving: false }))
    }
  }

  const toggleFullscreen = () => {
    setIsFullscreen((prev) => !prev)
  }

  // Updated containerClasses: on mobile (when not fullscreen) use full screen height.
  const containerClasses = isFullscreen
    ? "fixed inset-0 z-50 bg-background"
    : isMobile
    ? "h-screen w-full"
    : "h-full w-full"

  return (
    <div className={containerClasses}>
      {isFullscreen && (
        <div className="absolute top-0 left-0 right-0 z-10 p-2 flex justify-between items-center bg-background/80 backdrop-blur-sm">
          <h2 className="text-lg font-medium">3D Model Viewer</h2>
          <Button variant="ghost" size="icon" onClick={toggleFullscreen}>
            <X className="h-5 w-5" />
          </Button>
        </div>
      )}

      <ProjectDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        onProjectCreated={handleProjectCreated}
      />

      <div className={`${isMobile ? "min-h-[350px] h-[70vh]" : "h-full w-full"}`}>
        <Canvas shadows camera={{ position: [0, 0, 5] }} style={{ background: bg }}>
          <color attach="background" args={[bg]} />
          <Suspense fallback={null}>
            <ModelContent url={url} onError={handleError} />
          </Suspense>
        </Canvas>
      </div>

      {isMobile && !isFullscreen && (
        <Button
          variant="outline"
          size="sm"
          className="absolute top-2 right-2 h-7 bg-background/50 backdrop-blur-sm z-10"
          onClick={toggleFullscreen}
        >
          <Expand className="h-3 w-3 mr-1" />
          Fullscreen
        </Button>
      )}

      <div
        className={`${
          isFullscreen ? "absolute bottom-4" : "absolute bottom-2"
        } left-0 right-0 flex justify-center gap-1 z-10 px-2`}
      >
        <div className="flex gap-1 overflow-x-auto pb-1 max-w-full bg-background/40 backdrop-blur-sm rounded-lg p-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 bg-background/50 backdrop-blur-sm whitespace-nowrap"
            onClick={handleToggleTextures}
          >
            <Layers className="h-3 w-3 mr-1" />
            Toggle Textures
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-7 bg-background/50 backdrop-blur-sm whitespace-nowrap"
            onClick={() => {
              const link = document.createElement("a")
              link.href = url
              link.download = "model.glb"
              document.body.appendChild(link)
              link.click()
              document.body.removeChild(link)
            }}
          >
            <Download className="h-3 w-3 mr-1" />
            Download
          </Button>

          {inputImage && resolution && (
            <>
              <div className="flex gap-1">
                <Select
                  value={selectedProjectId || undefined}
                  onValueChange={(value) => setSelectedProjectId(value)}
                >
                  <SelectTrigger className="h-7 text-xs bg-background/50 backdrop-blur-sm w-28">
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7 bg-background/50 backdrop-blur-sm"
                  onClick={() => setProjectDialogOpen(true)}
                >
                  <FolderPlus className="h-3 w-3" />
                </Button>
              </div>

              <Button
                variant={state.saveSuccess ? "default" : "outline"}
                size="sm"
                className="h-7 bg-background/50 backdrop-blur-sm whitespace-nowrap"
                onClick={handleSaveModel}
                disabled={state.saving}
              >
                <Save className={`h-3 w-3 mr-1 ${state.saving ? "animate-spin" : ""}`} />
                {state.saving ? "Saving..." : state.saveSuccess ? "Saved" : "Save"}
              </Button>
            </>
          )}
        </div>
      </div>

      {state.error && (
        <Alert variant="destructive" className="absolute top-4 left-4 right-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function tempToColor(kelvin: number) {
  kelvin /= 100
  let red, green, blue
  if (kelvin <= 66) {
    red = 255
    green = Math.min(
      255,
      Math.max(0, 99.4708025861 * Math.log(kelvin) - 161.1195681661)
    )
    blue =
      kelvin <= 19
        ? 0
        : Math.min(
            255,
            Math.max(0, 138.5177312231 * Math.log(kelvin - 10) - 305.0447927307)
          )
  } else {
    red = Math.min(
      255,
      Math.max(0, 329.698727446 * Math.pow(kelvin - 60, -0.1332047592))
    )
    green = Math.min(
      255,
      Math.max(0, 288.1221695283 * Math.pow(kelvin - 60, -0.0755148492))
    )
    blue = 255
  }
  return `rgb(${red}, ${green}, ${blue})`
}